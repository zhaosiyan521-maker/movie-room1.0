import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, useAuthStore } from '../store/authStore';
import { getAbsoluteApiBase, toProxiedUrl } from '../store/apiBase';
import { getOrCreateHostSession, getHostSession, destroyHostSession, HostSession } from '../store/hostStreaming';
import { speedToScrollDuration } from '../utils/danmakuSpeed';
import { io, Socket } from 'socket.io-client';
import Hls from 'hls.js';
import './RoomView.css';

/**
 * 【HLS 播放策略】HLS 直链一律由「观众 / 房主本地网络直连源站」，不经过服务器中转。
 *
 * 原因：HLS 是分片流。若走 /api/video-proxy，服务器要为每一位观众转发每一片 .ts，
 * 出网带宽 = 观众数 × 码率，且所有观众从同一个出口 IP 并发拉流，很容易触发源站限流
 * 甚至封 IP。改为本地直连后，服务器带宽占用为 0。
 *
 * 代价（已确认接受）：源站若未下发 Access-Control-Allow-Origin，hls.js 用 XHR 拉清单 /
 * 分片时会被浏览器直接拦截（清单都拉不到，第一步就失败）；另有一批源站做 Referer 防盗链，
 * 同样会拒。这两类源站将无法播放，且没有服务器中转兜底。实测常见公开 HLS 源站中约三分之
 * 二放行直连，约三分之一不放行（如 devstreaming-cdn.apple.com、sample.vodobox.net）。
 * 失败提示见 attachHls 的 ERROR 处理，会把「源站未开放跨域 / 有防盗链」讲清楚。
 *
 * 注意：mp4 / webm 等非 HLS 直链仍保留「直连优先、失败降级走一次代理」的策略
 * （见 retryDirectViaProxy），本次改动未触碰该逻辑。
 */

interface RoomMemberInfo {
  userId: string;
  nickname: string;
  socketId?: string;
}

interface Room {
  id: string;
  name: string;
  description?: string;
  images?: string | null;
  status: string;
  /** 服务端只下发是否存在密码，不再下发明文密码 */
  hasPassword?: boolean;
  maxViewers: number;
  currentMovie?: string;
  hostId: string;
  host: {
    id: string;
    username: string;
    nickname: string;
  };
  members: Array<{
    id: string;
    role: string;
    user: {
      id: string;
      username: string;
      nickname: string;
    };
  }>;
}

interface ChatMessage {
  from: string;
  userId: string;
  message: string;
  timestamp: string;
}

interface DanmakuItem {
  id: number;
  text: string;
  top: number;      // 垂直轨道位置（百分比 0~85）
  duration: number; // 滚动动画时长（秒）
}

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const CHAT_COOLDOWN_SEC = 3;
const CHAT_MAX_LENGTH = 50;

function parseImages(images?: string | null): string[] {
  if (!images) return [];
  try {
    const arr = JSON.parse(images);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 秒 → 时间文本（HH:MM:SS 或 MM:SS），用于观众端只读进度显示
function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, '0');
  const sss = String(ss).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

// 语音音量 → 颜色：低音量绿色，高音量红色（绿→黄→红）
function speakingColor(level: number): string {
  const hue = 120 - Math.max(0, Math.min(1, level)) * 120; // 120(绿) → 0(红)
  return `hsl(${Math.round(hue)}, 75%, 50%)`;
}

// 用户头像纯色：按 userId 哈希到固定色板，同一用户恒定同色、不带文字。
const AVATAR_COLORS = [
  '#F858AF', '#5B8DEF', '#F5A623', '#46C48A', '#9B6BF3',
  '#EF5350', '#26C6DA', '#FF7043', '#66BB6A', '#AB47BC',
  '#EC407A', '#42A5F5', '#FFCA28', '#8D6E63', '#7E57C2'
];
function avatarColor(userId: string): string {
  if (!userId) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * 把远程视频直链改写为同源代理地址，以绕过跨域 / 防盗链（Referer/Origin）限制。
 * 已抽取到 store/apiBase.ts 的 toProxiedUrl，返回「绝对」地址，
 * 避免 Electron(file://) / 非 5173 端口下相对路径失效导致"视频加载失败"。
 */

export default function RoomView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, fetchUser } = useAuthStore();

  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [joined, setJoined] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [error, setError] = useState('');

  // WebRTC 相关
  const socketRef = useRef<Socket | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const makingOfferRef = useRef<Map<string, boolean>>(new Map());
  // 完美协商（Perfect Negotiation）所需状态：
  //   isSettingRemoteAnswerPending —— 正在/已经应用远端 answer。此状态下收到对方的 offer
  //     属于「双向协商同时进行」，必须允许非 collision 判定。
  //   makeOfferRef —— 每个 peer 专属的「发起一次协商」函数。原来挂在 pc 实例的私有属性上，
  //     改为 Map 管理，避免污染 RTCPeerConnection 对象。
  const isSettingRemoteAnswerPendingRef = useRef<Map<string, boolean>>(new Map());
  const makeOfferRef = useRef<Map<string, () => Promise<void>>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // 全屏容器引用：全屏时气泡/聊天公屏需要渲染在该元素内部，否则不会显示
  const videoContainerRef = useRef<HTMLDivElement>(null);
  // 房主本地视频的挂载容器：session.video 是模块级单例元素（跨页面存活），
  // 这里用一个回调 ref 把它挂载进组件展示区，切页时再移回 document.body 隐藏。
  const hostVideoMountRef = useRef<HTMLDivElement | null>(null);
  const [isHost, setIsHost] = useState(false);
  // isHost 的同步镜像：setupWebSocket 在 doJoin（async，捕获旧闭包）里被调用时，
  // isHost state 可能尚未更新，故用 ref 同步记录，确保房主分支判断准确。
  const isHostRef = useRef(false);
  // 房主推流会话是否已就绪（session 在 setupWebSocket 里创建，晚于首次渲染；
  // 用它触发一次重渲染，让挂载 effect 把 session.video 挂进展示容器）
  const [hostSessionReady, setHostSessionReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  // isPlaying 的同步镜像：setupWebSocket 里的 onpause/onplay 闭包会捕获旧 state，
  // 导致「房主暂停/继续」广播发不出去（同 isHostRef 一类的闭包时序 bug）。
  const isPlayingRef = useRef(false);
  const [needClickPlay, setNeedClickPlay] = useState(false);
  // 观众端「声音被浏览器自动播放策略拦截」提示：
  // 观众 <video> 属于远程流且通常在无用户手势时自动 play()，带声音的自动播放会被浏览器拒绝。
  // 此时改为静音自动播放（保证有画面），并提示用户点击一次解锁声音。
  // 注意：不能用上面的 needClickPlay —— 它的渲染条件是 isHost，观众侧永远不会显示。
  const [needUnmute, setNeedUnmute] = useState(false);
  // 假暂停抑制窗口：房主切页回来时，挂载 effect 把 session.video 从 body 移回容器，
  // HTML 规范下媒体元素在 DOM 中移动会触发一次 pause 事件。这个窗口用于忽略该「假暂停」，
  // 避免误判为「房主主动暂停」而向观众广播 host-pause。
  const suppressPauseRef = useRef(0);
  // 【原生控制条】本场放映是否「进行中」：房主点了「播放网络视频」后为 true，
  // 「结束放映」（本地清理或收到服务端 playback-stop）后为 false。
  // 原生控制条的 play/pause 只有在本场进行中时才需要广播给观众。
  // ⚠️ 不能用 isPlaying 代替它：房主用原生键暂停后 isPlaying 就已经是 false，
  // 拿它当守卫会导致「暂停之后按原生播放键失灵」——这正是旧实现的 bug。
  const hostScreenActiveRef = useRef(false);
  // 【原生控制条】观众端专用：房主是否已经开过这场放映。
  // 用来区分「还没开始」（→ 等待房主开始播放）与「开始了但暂停了」（→ 房主已暂停）。
  // 只存在于观众端 —— 房主端已不再自绘任何暂停提示。
  const [screeningStarted, setScreeningStarted] = useState(false);

  // ===== 全屏观看 + 弹幕设置 =====
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 全屏时是否打开弹幕设置 + 发送面板
  const [showOverlayChat, setShowOverlayChat] = useState(false);

  // 成员 / 语音 / 聊天
  const [members, setMembers] = useState<RoomMemberInfo[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [inVoice, setInVoice] = useState(false);
  const [voiceUserIds, setVoiceUserIds] = useState<Set<string>>(new Set());
  const [speakingUserIds, setSpeakingUserIds] = useState<Set<string>>(new Set());
  const [mutedUserIds, setMutedUserIds] = useState<Set<string>>(new Set());
  const [micOn, setMicOn] = useState(true);
  // micOn 的同步镜像：startSpeakingDetection 里的说话检测是一个通过 setTimeout
  // 永久自递归的循环，闭包永远停留在创建那一次的渲染上。若直接读 micOn state，
  // 用户「关闭麦克风 → 重新打开」后检测函数里拿到的仍是最初的 true/false，
  // 导致重新打开麦克风后说话高亮永久失效。这里用 ref 同步镜像解决。
  const micOnRef = useRef(true);
  const [chatInput, setChatInput] = useState('');
  const [chatCooldown, setChatCooldown] = useState(0);
  const [menuUserId, setMenuUserId] = useState<string | null>(null);
  const [menuRect, setMenuRect] = useState<{ x: number; y: number } | null>(null);

  // ===== 弹幕 =====
  // 所有聊天内容以弹幕形式在视频区域滚动显示（不再用消息列表）。
  // 弹幕为「本地视角」呈现：不透明度 / 滚动速度 / 颜色均为用户个人偏好，不同步给他人。
  const [danmaku, setDanmaku] = useState<DanmakuItem[]>([]);
  const [danmakuOpacity, setDanmakuOpacity] = useState(1);
  const [danmakuSpeed, setDanmakuSpeed] = useState(3); // 1~5 档，越大越快
  const [danmakuColor, setDanmakuColor] = useState('#ff4d4f'); // 红/黄/蓝/绿（默认红）
  const [showDanmakuSettings, setShowDanmakuSettings] = useState(false);
  const danmakuSeqRef = useRef(0);

  // 注意：【需求4A】管理员广播条不在本组件渲染 —— 它由 Layout 统一渲染（房间页 + 大厅共用），
  // 数据订阅见 hooks/useBroadcast（全应用共用一条 socket）。此处不再维护独立的广播状态。

  // 语音音量等级（0~1），用于头像按音量着色
  const [levelByUser, setLevelByUser] = useState<Record<string, number>>({});

  // 分辨率同步（房主视频分辨率徽标）
  const [resolution, setResolution] = useState<string | null>(null);

  // 观众端只读进度显示（当前播放时间 / 总时长）
  const [progress, setProgress] = useState<{ current: number; duration: number }>({ current: 0, duration: 0 });
  // 观众端进度条显隐：鼠标移动/点击时显示，3 秒无操作自动隐藏
  const [showViewerBar, setShowViewerBar] = useState(false);
  const viewerBarTimerRef = useRef<number | null>(null);

  // 网络视频播放模式（房主粘贴直链，观众各自加载，不经过房主带宽）
  const [usingRemoteUrl, setUsingRemoteUrl] = useState(false);
  // usingRemoteUrl 的同步镜像：addLocalTracksTo 在 room-joined 异步回调里被调用，
  // 闭包捕获的 state 可能滞后，需用 ref 保证判断准确。
  const usingRemoteUrlRef = useRef(false);
  const [remotePlayUrl, setRemotePlayUrl] = useState('');
  const [urlInput, setUrlInput] = useState('');
  // 视频加载错误提示：网络直链可能因跨域/失效而失败，需要明确反馈而非"点了没反应"
  const [videoError, setVideoError] = useState('');
  // 【播放源持久化】点「设为播放源」后服务端回执"已保存到房间"的短提示。
  // 该直链保存在房间记录里，暂停/结束放映/刷新/切页都不会丢，只有解散房间才消失。
  const [sourceSavedTip, setSourceSavedTip] = useState(false);
  const sourceSavedTimerRef = useRef<number | null>(null);

  // 电影播放完毕：房主弹窗「是否解散该房间」
  const [endedPrompt, setEndedPrompt] = useState(false);

  // ===== 直链获取（服务端嗅探）=====
  const [showSniffInput, setShowSniffInput] = useState(false); // 输入弹窗
  const [sniffInput, setSniffInput] = useState('');            // 原视频网址
  const [sniffLoading, setSniffLoading] = useState(false);     // 生成直链中
  const [sniffError, setSniffError] = useState('');            // 错误提示
  const [showSniffResult, setShowSniffResult] = useState(false); // 结果弹窗
  const [sniffTitle, setSniffTitle] = useState('');            // 页面标题
  const [sniffUrls, setSniffUrls] = useState<string[]>([]);    // 捕获到的直链列表
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null); // 已复制的直链

  const hlsRef = useRef<any>(null);
  const setupDoneRef = useRef(false);
  const recentMsgSigRef = useRef<Set<string>>(new Set());
  // 进度同步节流：记录上次广播时间戳
  const lastSyncProgressRef = useRef(0);
  // 观众端 seek 冷却：记录上次强制 seek 时间戳，避免 HLS 缓冲期间被反复 seek 打断
  const lastViewerSeekRef = useRef(0);
  // 观众加入房间时刻：加入后前 5 秒内不参与周期纠偏，避免初始加载期间纠偏 seek 与缓冲打架
  const viewerJoinedAtRef = useRef(0);
  // 房主推流会话（模块级单例）：房主切页时推流资源跨页面存活
  const hostSessionRef = useRef<HostSession | null>(null);

  const localMicRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const speakingRef = useRef(false);
  const cooldownTimerRef = useRef<any>(null);

  // 【直链-1】当前正在播放的「原始直链」及其是否 HLS。
  // 非 HLS 直链由 <video src> 直连源站以节省服务器带宽；一旦加载失败，需要据此把同一条
  // 链接改为「走服务端代理」再重试一次（见 retryDirectViaProxy）。
  // HLS 不走这条降级路径：一律本地直连，失败即提示（见文件顶部策略说明）。
  const directUrlRef = useRef('');
  const directIsHlsRef = useRef(false);
  // 【直链-5】观众端 loadRemoteVideo 的「元素未就绪」重试定时器句柄。
  // 旧实现每 100ms 无条件递归重试，若 room-joined 与 playback-start 在 <video>
  // 挂载前先后到达，会拉起两条互相独立的重试链，各自 attachHls 到同一个元素，
  // 产生多个 HLS 实例争抢（旧实例成为无人持有的孤儿，后台持续拉分片）。
  const viewerLoadTimerRef = useRef<any>(null);
  // HLS 网络错误的自动重试计数。hls.js 遇到致命网络错误（多为直链失效/过期）时会
  // 不断触发 ERROR，早期实现无条件 startLoad() 重试，于是永远填不满缓冲区、
  // 也永远不报错，用户看到的就是「一直黑屏、且没有任何提示」。
  const hlsRetryRef = useRef(0);

  useEffect(() => {
    if (!user) {
      fetchUser();
    }
  }, []);

  // 关键：用 useLayoutEffect 而非 useEffect 做卸载清理。
  // React 卸载组件时先移除 DOM（房主的 <video> 会被 removeChild，进入 detached 状态），
  // 后异步执行 useEffect cleanup；detached 会让 captureStream 推流轨道停止产帧、观众画面冻结。
  // useLayoutEffect 的 cleanup 在 DOM 移除之前同步执行，能先把视频移回 body，避免 detached。
  useLayoutEffect(() => {
    fetchRoom();

    return () => {
      cleanupAll();
    };
  }, [id]);

  const cleanupAll = (disposeHostSession = false) => {
    // 房主：切换页面（disposeHostSession=false）时保留推流会话（socket + 本地视频 + WebRTC peers 继续存活），
    // 只有观众或房主主动「解散/退出」（disposeHostSession=true）才彻底断开。
    // 用全局 hostStreaming Map 判断是否为房主（最可靠，不受组件 state 时序影响）。
    const hasHostSession = !!getHostSession(id!) || !!hostSessionRef.current;
    const shouldDisposeHost = hasHostSession && disposeHostSession;

    if (socketRef.current) {
      // 房主切页：保留 socket 连接（不 disconnect），但清空组件内引用；
      // 连接仍由 hostStreaming 单例的 session.socket 持有，观众画面/服务端状态不受影响。
      if (!hasHostSession || shouldDisposeHost) {
        // 观众（或房主主动解散）离开：先主动 emit leave-room 让服务端同步移除，
        // 再 disconnect。否则只 disconnect 时服务端要等断开事件异步触发才清理，
        // 观众切房间后会短暂残留在旧房间（旧房间仍显示其在线）。
        if (id) {
          try { socketRef.current.emit('leave-room', id); } catch {}
        }
        socketRef.current.disconnect();
      }
      socketRef.current = null;
    }
    // 关键修复：必须复位 setupDoneRef。
    // 否则 React Router 在 /room/A → /room/B 时复用同一组件实例，
    // setupWebSocket() 会命中 if (setupDoneRef.current) return 而直接早退，
    // 导致切换房间后聊天/语音/视频/成员操作全部永久失效（直到刷新页面）。
    setupDoneRef.current = false;

    // 【直链-5】组件卸载时作废观众端的加载重试定时器，
    // 避免它在组件销毁后仍然触发 loadRemoteVideo（对已卸载的 <video> 发起重复加载）。
    if (viewerLoadTimerRef.current) {
      clearTimeout(viewerLoadTimerRef.current);
      viewerLoadTimerRef.current = null;
    }

    // 销毁 HLS 实例：否则旧实例会继续拉取分片，占用带宽与内存
    // 注意：房主切页时不清 HLS，否则网络直链模式下房主回来后需重新加载（观众不受影响）。
    if (!hasHostSession || shouldDisposeHost) {
      destroyHls();
    }

    // 房主：切页时保留 peers（推流通道）与本地视频；观众或房主主动离开：关闭所有 peers
    if (!hasHostSession || shouldDisposeHost) {
      peersRef.current.forEach(pc => pc.close());
      peersRef.current.clear();
    } else {
      // 房主切页：把本地视频元素移出 React 组件（append 到 body 隐藏），
      // 使 captureStream 的推流轨道不因 React 卸载 <video> 而停止，观众画面不断。
      const localEl = localVideoRef.current;
      if (localEl && hostSessionRef.current) {
        hostSessionRef.current.video = localEl;
        // 关键修复：先解绑事件，再移动 DOM。
        // appendChild 把 video 移出 React 容器会触发一次「假 pause」。若 onpause 仍绑定，
        // 此时 isPlayingRef 还是 true、suppressPauseRef 又是旧值，会误广播 host-pause 给观众，
        // 服务端把 playing 置 false → 观众暂停、新加入观众黑屏（网络直链模式尤为明显）。
        // 因此先解绑事件（假 pause 无处理器可触发），再移动，彻底阻断误广播。
        localEl.onloadedmetadata = null;
        localEl.onended = null;
        localEl.onerror = null;
        // 注意：不解绑 ontimeupdate！房主切页后 session.video 仍在 body 上继续播放
        // （网络直链 HLS 孤儿 / 本地文件都继续），进度仍在真实推进。保留 ontimeupdate
        // 让进度持续上报（handler 内部已改用持久 session.socket），这样房主回来
        // （或新观众加入）才能追到切页后的真实进度，而不是停在切页时刻。
        localEl.onpause = null;
        localEl.onplay = null;
        localEl.onseeked = null;
        // 设置抑制窗口兜底（双保险），即使有其他路径触发 pause 也不会误广播
        suppressPauseRef.current = Date.now();
        // 注意：绝不能 pause()！房主切页后视频仍需继续播放，captureStream 的
        // 推流轨道才会持续产出帧，观众画面才不会冻结。只做隐藏，不暂停。
        localEl.style.position = 'fixed';
        localEl.style.left = '-9999px';
        localEl.style.opacity = '0';
        localEl.style.pointerEvents = 'none';
        // 若尚未在 body 上，则挂载；React 卸载时因节点已移走而不会真正销毁它
        if (localEl.parentNode !== document.body) {
          document.body.appendChild(localEl);
        }
        // 重置挂载信号，房主回到房间时由 setupWebSocket 重新置 true 触发重挂载
        setHostSessionReady(false);
      }
    }
    audioElsRef.current.forEach(el => {
      el.pause();
      el.srcObject = null;
    });
    audioElsRef.current.clear();
    remoteStreamsRef.current.clear();
    if (localMicRef.current) {
      localMicRef.current.getTracks().forEach(t => t.stop());
      localMicRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);

    // 重置房间相关状态，避免上一个房间的聊天与 UI 状态串到新房间
    setDanmaku([]);
    setLevelByUser({});
    setMutedUserIds(new Set());
    setSpeakingUserIds(new Set());
    setVoiceUserIds(new Set());
    setOnlineUserIds(new Set());
    setResolution(null);
    setNeedUnmute(false);
    setUsingRemoteUrl(false);
    usingRemoteUrlRef.current = false;
    setRemotePlayUrl('');
    setVideoError('');
    setIsPlaying(false);
    isPlayingRef.current = false;
    setEndedPrompt(false);
    recentMsgSigRef.current.clear();
  };

  const fetchRoom = async () => {
    try {
      const { data } = await api.get(`/rooms/${id}`);
      const r: Room = data.room;
      setRoom(r);
      setMembers(r.members.map(m => ({
        userId: m.user.id,
        nickname: m.user.nickname || m.user.username
      })));

      const me = useAuthStore.getState().user;
      if (me) {
        const hostFlag = r.hostId === me.id;
        isHostRef.current = hostFlag;
        setIsHost(hostFlag);
        const alreadyMember = r.members.some(m => m.user.id === me.id);
        if (alreadyMember) {
          doJoin();
        }
      }
    } catch (error: any) {
      setError(error.response?.data?.error || '获取房间信息失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && room && !joined) {
      const hostFlag = room.hostId === user.id;
      isHostRef.current = hostFlag;
      setIsHost(hostFlag);
      const alreadyMember = room.members.some(m => m.user.id === user.id);
      if (alreadyMember) {
        doJoin();
      }
    }
  }, [user, room]);

  const doJoin = async (password?: string) => {
    try {
      await api.post(`/rooms/${id}/join`, {
        password: password || undefined
      });

      setJoined(true);
      setError('');
      setupWebSocket();
    } catch (error: any) {
      setError(error.response?.data?.error || '加入房间失败');
    }
  };

  const handleJoin = () => doJoin(passwordInput);

  // 房主本地视频挂载：session.video 是模块级单例（切页后继续存活），
  // 当房主进入房间且 session 就绪时，把它从 body 移回组件展示容器，恢复可见。
  // 必须在 session 创建（setupWebSocket）之后执行，故依赖 hostSessionReady 而非回调 ref。
  useEffect(() => {
    if (!isHost || !hostSessionReady) return;
    const container = hostVideoMountRef.current;
    const session = hostSessionRef.current;
    const v = session?.video;
    if (!container || !v) return;
    if (v.parentNode !== container) {
      v.style.position = '';
      v.style.left = '';
      v.style.top = '';
      v.style.width = '100%';
      v.style.height = '100%';
      v.style.opacity = '';
      v.style.pointerEvents = '';
      container.appendChild(v);
      // DOM 移动会触发一次「假 pause」，设置抑制窗口避免向观众误广播 host-pause
      suppressPauseRef.current = Date.now();
      // 若视频本应处于播放态（房主切页回来），立即恢复播放，抵消移动导致的暂停
      if (isPlayingRef.current) {
        v.play().catch(() => {});
      }
    }
    localVideoRef.current = v;
  }, [isHost, hostSessionReady]);

  // ===== WebSocket =====

  const setupWebSocket = () => {
    // 防止重复初始化导致监听器叠加（聊天消息重复的根因）
    if (setupDoneRef.current) return;
    setupDoneRef.current = true;

    const token = localStorage.getItem('token');

    // 房主：复用模块级持久 socket（跨页面切换存活），切换页面不断推流、服务端不判离开。
    // 观众：每次进入房间新建 socket（组件卸载即断开）。
    // 用 isHostRef（同步镜像）而非 isHost state：setupWebSocket 在 doJoin 的 await 之后被调用，
    // 此时闭包里的 isHost 可能仍是旧值，导致房主被误判为观众。
    let socket: Socket;
    if (isHostRef.current) {
      const session = getOrCreateHostSession(id!);
      hostSessionRef.current = session;
      socket = session.socket;
      // 把组件级 peersRef 挂到会话级 Map 上：useRef 不跨组件实例存活，房主切页后旧 PC 会失控泄漏
      // （僵尸连接继续占带宽）。挂到 session 后切页期间连接真正被保留，回房后可直接复用。
      peersRef.current = session.peers;
      // 房主回到房间（或首次进入）时，清掉旧组件残留的监听器，避免叠加
      socket.removeAllListeners();
      // 触发重渲染，让挂载 effect 把 session.video 挂进展示容器（否则房主看不到画面）
      setHostSessionReady(true);
      // 关键修复：socket 是模块级单例，房主切页后再回来时它已经处于 connected 状态，
      // 不会再触发 'connect' 事件，导致 join-room 永不重新 emit、服务端不下发 room-joined，
      // 房主回来后 isPlaying 停在 false，UI 显示「请粘贴视频直链并开始播放」——看起来就像视频自动结束了。
      // 因此：若 socket 已连接，直接补发 join-room，让服务端重新下发播放状态（playbackState）。
      if (socket.connected) {
        socket.emit('join-room', id);
        if (hostSessionRef.current) {
          hostSessionRef.current.joinedRoom = true;
        }
      }
    } else {
      socket = io(`${getAbsoluteApiBase()}`, {
        auth: { token },
        transports: ['websocket']
      });
    }

    socketRef.current = socket;

    // 房主：为持久 video 元素绑定组件级事件（进度同步 / 播完 / 错误 / 分辨率）。
    // 组件卸载（切页）时由 cleanupAll 解绑，回到房间时重新绑定，避免监听器叠加。
    if (isHostRef.current && hostSessionRef.current) {
      const v = hostSessionRef.current.video as HTMLVideoElement;
      v.onloadedmetadata = () => setResolution(getResolution());
      v.onended = handleHostMovieEnded;
      v.onerror = () => {
        // 【直链-1】直连失败先降级走服务端代理重试（绕过防盗链），仍失败才算真的失败
        if (retryDirectViaProxy(v)) {
          // 房主自己的 <video> 没有 autoPlay 属性，换 src 后需要显式触发播放
          v.play().catch(() => setNeedClickPlay(true));
          return;
        }
        const code = (v.error && v.error.code) || 0;
        let msg = '视频加载失败，请检查文件格式或网络链接是否有效';
        if (code === MediaError.MEDIA_ERR_NETWORK) msg = '网络错误：直链不可达或已被服务器拒绝（防盗链/失效/跨域）';
        else if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) msg = '格式不支持：该直链无法播放，或 HLS 流未被正确识别';
        setVideoError(`${msg}。多数站点直链有时效，请重试或更换链接。`);
        setNeedClickPlay(true);
      };
      v.ontimeupdate = () => {
        const el = v;
        // 关键：用持久 socket（session.socket）上报，而不是 socketRef.current。
        // 房主切页后 socketRef.current 会被置 null，但 session.socket 仍存活且已连接，
        // 这样房主切页期间 session.video 继续播放时，进度仍能持续上报给服务端，
        // 房主回来（或新观众加入）才能追到切页后的真实进度，而不是停在切页时刻。
        const sock = hostSessionRef.current?.socket ?? socketRef.current;
        if (!el || !sock) return;
        const now = Date.now();
        if (now - lastSyncProgressRef.current < 2000) return;
        lastSyncProgressRef.current = now;
        sock.emit('sync-progress', {
          roomId: id,
          currentTime: el.currentTime,
          duration: el.duration || 0
        });
      };
      // 【原生控制条】房主用浏览器自带控制条暂停/继续 —— 这是本项目唯一的暂停/播放入口，
      // 网页端不再自绘播放/暂停按钮或暂停遮罩。
      // 这里必须**同时**改本地 UI 状态并广播：
      //   旧实现只广播、不改本地状态，且用 isPlayingRef 当守卫 —— 房主按原生暂停后
      //   （服务端把 playback-pause 广播回房间）isPlayingRef 变成 false，此时再按原生
      //   播放键，守卫 `if (isPlayingRef.current)` 不成立 → 既不广播也不复位状态，
      //   于是「已暂停」永久卡住、观众一直停着，而房主本地视频其实已经在播（房间失同步）。
      //   改为用 hostScreenActiveRef（本场是否进行中）当守卫，与「当前是否正在播放」解耦。
      v.onpause = () => {
        // 忽略「假暂停」：切页回来时 DOM 移动触发的 pause（抑制窗口内），不应广播。
        if (Date.now() - suppressPauseRef.current < 800) return;
        // 本场未进行（从未开播 / 已结束放映）时不广播
        if (!hostScreenActiveRef.current) return;
        // 已经是暂停态就不重复广播（加载、拖拽等会多次触发 pause）
        if (!isPlayingRef.current) return;
        setIsPlaying(false);
        isPlayingRef.current = false;
        const sock = hostSessionRef.current?.socket ?? socketRef.current;
        sock?.emit('host-pause', { roomId: id });
      };
      v.onplay = () => {
        if (Date.now() - suppressPauseRef.current < 800) return;
        if (!hostScreenActiveRef.current) return;
        // 已经在播放态，无需重复广播
        if (isPlayingRef.current) return;
        setIsPlaying(true);
        isPlayingRef.current = true;
        const sock = hostSessionRef.current?.socket ?? socketRef.current;
        sock?.emit('host-resume', { roomId: id });
      };
      // 房主拖动进度条（原生控制条）seek 后，广播给观众跟随 seek。
      // 用持久 socket（session.socket）上报，保证房主切页场景下（若有）也安全。
      v.onseeked = () => {
        if (Date.now() - suppressPauseRef.current < 800) return;
        const sock = hostSessionRef.current?.socket ?? socketRef.current;
        if (sock && Number.isFinite(v.currentTime)) {
          sock.emit('host-seek', { roomId: id, currentTime: v.currentTime });
        }
      };
    }

    socket.on('connect', () => {
      socket.emit('join-room', id);
      if (isHostRef.current && hostSessionRef.current) {
        hostSessionRef.current.joinedRoom = true;
      }
      const me = useAuthStore.getState().user;
      if (me) {
        setOnlineUserIds(prev => new Set(prev).add(me.id));
      }
    });

    // 注意：【需求4A】广播的实时订阅已收敛到 Layout（hooks/useBroadcast，全应用共用一条
    // socket），本组件不再重复监听 broadcast-update，否则会与 Layout 重复渲染广播条。

    socket.on('room-joined', async (data: any) => {
      // 【播放源持久化】先把服务端保存的播放源回填到本地状态 / 输入框。
      // 关键：这一步与「房主是否正在放映」**无关**。旧实现只在 playbackState.playing
      // 为 true 时才回填直链，而房主一暂停服务端就会把内存里的 playing 置为 false，
      // 于是房主暂停后刷新页面 / 切页回来时，输入框回落到「尚未设置播放源」——
      // 看起来就像"一暂停播放源就被清除了"。播放源落库在 rooms.sourceUrl，
      // 只在房间被解散时才消失，这里无条件恢复。
      if (typeof data.savedSource?.videoUrl === 'string' && data.savedSource.videoUrl) {
        const savedUrl = data.savedSource.videoUrl;
        setRemotePlayUrl(savedUrl);
        // 输入框仅在为空时预填，避免覆盖用户正在编辑的内容
        setUrlInput(prev => prev || savedUrl);
        setUsingRemoteUrl(true);
        usingRemoteUrlRef.current = true;
      }

      setOnlineUserIds(prev => {
        const next = new Set(prev);
        data.users.forEach((u: any) => u.userId && next.add(u.userId));
        return next;
      });
      setVoiceUserIds(prev => {
        const next = new Set(prev);
        data.users.forEach((u: any) => {
          if (u.inVoice && u.userId) next.add(u.userId);
        });
        return next;
      });
      setMembers(prev => {
        const next = [...prev];
        data.users.forEach((u: any) => {
          if (!u.userId) return;
          const idx = next.findIndex(m => m.userId === u.userId);
          if (idx >= 0) {
            // 已存在则刷新 socketId：断线重连会换新 socketId，旧值会让「静音此人」失效
            next[idx] = { ...next[idx], socketId: u.socketId };
          } else {
            next.push({ userId: u.userId, nickname: u.nickname || u.username, socketId: u.socketId });
          }
        });
        return next;
      });

      // 房主回房时 peers 是会话级持久 Map：清掉已不在房间的僵尸连接，避免残留占用
      const presentSocketIds = new Set<string>(
        data.users.map((u: any) => u.socketId).filter(Boolean)
      );
      peersRef.current.forEach((_pc, sid) => {
        if (!presentSocketIds.has(sid)) removePeer(sid);
      });

      for (const u of data.users) {
        if (u.socketId) {
          await createPeerConnection(u.socketId);
        }
      }

      // 若房间正在放映，立即续播并追到房主当前进度。
      // 关键：区分「房主自己回来」与「观众加入」——
      //   观众：用 remoteVideoRef 加载/续播；
      //   房主：恢复本地视频（session.video）的播放状态，而不是去操作 remoteVideoRef。
      //
      // 【原生控制条】房主端还要标记「本场是否进行中」：
      // 服务端只有在本场仍未作废时才会下发 playbackState（内存命中，
      // 或房间 status==='PLAYING' 且库里有源的回落）。所以 playbackState 非 null
      // 就等价于「本场进行中（可能正暂停）」→ 房主按原生播放键应当恢复整场放映。
      // 反之「结束放映」后内存被删、status 改回 WAITING、sourceUrl 置空 → null → 不再广播。
      hostScreenActiveRef.current = !!data.playbackState;
      setScreeningStarted(!!data.playbackState);

      if (data.playbackState?.playing) {
        const ps = data.playbackState;
        setIsPlaying(true);
        isPlayingRef.current = true;
        setResolution(ps.resolution || null);

        if (isHostRef.current) {
          // 房主切页回来：session.video 一直存活（挂在 body 隐藏），只需恢复播放态。
          // 注意：若视频尚无片源（刚进房未选文件），play() 会失败/转圈，这里仅在有片源时才续播。
          const lv = hostSessionRef.current?.video;
          if (lv) {
            if (ps.videoUrl) {
              // 网络直链模式：房主本地需要重新加载直链（切页后 hlsRef/组件级资源已释放）
              usingRemoteUrlRef.current = true;
              setUsingRemoteUrl(true);
              setRemotePlayUrl(ps.videoUrl);
              // 传入当前进度，重载后追回，避免从 0 重新播放导致与观众进度脱节
              loadLocalUrl(ps.videoUrl, !!ps.isHls, typeof ps.currentTime === 'number' ? ps.currentTime : 0);
            } else {
              // 历史遗留的「本地文件模式」分支（当前产品只支持网络直链，正常不会走到这里）：
              // session.video 的 src 仍在（切页未 revoke），只需恢复播放。
              // 注意**不清空 remotePlayUrl** —— 播放源是房主设定的持久数据，
              // 不因走了哪条分支而丢失。
              if (lv.src || lv.currentSrc) {
                lv.play().catch(() => setNeedClickPlay(true));
              }
            }
          }
        } else if (ps.videoUrl) {
          // 观众 + 网络视频模式：加载直链，并把房主当前进度直接传入，
          // 让 HLS 从目标位置开始拉流（startPosition），跳过「从 0 缓冲再 seek」的双重缓冲。
          setRemotePlayUrl(ps.videoUrl);
          const startAt = typeof ps.currentTime === 'number' ? ps.currentTime : 0;
          // 记录加入时刻：前 5 秒内不参与周期纠偏，避免初始加载期间纠偏 seek 与缓冲打架
          viewerJoinedAtRef.current = Date.now();
          loadRemoteVideo(ps.videoUrl, !!ps.isHls, startAt);
        } else {
          // 观众 + 本地文件 WebRTC 模式：房主转发的流会自动续播，无需手动追进度
          setRemotePlayUrl('');
          destroyHls();
          // 【C3】观众端播放失败不再静默吞掉：自动播放被拦截时静音兜底 + 提示解锁声音
          playViewerVideo(remoteVideoRef.current);
        }
      }
    });

    socket.on('user-joined', (data: any) => {
      if (data.userId) {
        setOnlineUserIds(prev => new Set(prev).add(data.userId));
        setMembers(prev => {
          // 断线重连的同 userId 用户会换新 socketId：更新旧条目，否则「静音此人」拿到失效的 socketId
          if (prev.some(m => m.userId === data.userId)) {
            return prev.map(m => m.userId === data.userId
              ? { ...m, socketId: data.socketId, nickname: data.nickname || data.username || m.nickname }
              : m);
          }
          return [...prev, { userId: data.userId, nickname: data.nickname || data.username, socketId: data.socketId }];
        });
      }
    });

    socket.on('user-left', (data: any) => {
      if (data.userId) {
        setOnlineUserIds(prev => {
          const next = new Set(prev);
          next.delete(data.userId);
          return next;
        });
        setVoiceUserIds(prev => {
          const next = new Set(prev);
          next.delete(data.userId);
          return next;
        });
        setSpeakingUserIds(prev => {
          const next = new Set(prev);
          next.delete(data.userId);
          return next;
        });
      }
      if (data.socketId) {
        removePeer(data.socketId);
      }
    });

    // 统一处理远端协商描述（offer / answer）——完美协商模式。
    // 相比旧实现（polite/impolite + 遇到非 stable 直接 return），这里的关键差别是：
    //  1. collision 判定只针对 offer，且由 polite 的一方通过 setRemoteDescription
    //     内部自动 rollback 来让步，impolite 方直接忽略冲突 offer；不再产生
    //     InvalidStateError 导致的协商链断裂。
    //  2. setRemoteDescription 触发 rollback 后，本端已 addTrack / addTransceiver 的
    //     收发器仍然存在，浏览器会把 negotiation-needed 标志重新置位，从而自动补发
    //     一次真正携带 m-line 的 offer。这正是「观众播放中途加入黑屏无声」的自愈通道。
    const applyRemoteDescription = async (from: string, desc: any) => {
      const pc = peersRef.current.get(from);
      if (!pc || !desc) return;
      const isOffer = desc.type === 'offer';

      if (isOffer) {
        const polite = isPolite(from);
        const makingOffer = makingOfferRef.current.get(from) || false;
        const isSettingRemoteAnswerPending = isSettingRemoteAnswerPendingRef.current.get(from) || false;
        // 只有「我刚发了 offer」或「正在处理远端 answer」之外的情况才算可接受状态
        const readyForOffer =
          !makingOffer && (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
        if (!polite && !readyForOffer) return; // impolite 方不让步，等对方 rollback
      }

      try {
        isSettingRemoteAnswerPendingRef.current.set(from, !isOffer);
        await pc.setRemoteDescription(new RTCSessionDescription(desc));
        isSettingRemoteAnswerPendingRef.current.set(from, false);
        if (isOffer) {
          await pc.setLocalDescription();
          socket.emit('answer', { target: from, answer: pc.localDescription });
        }
      } catch (err) {
        console.error('处理远端协商描述失败:', err);
      } finally {
        isSettingRemoteAnswerPendingRef.current.set(from, false);
      }
    };

    socket.on('offer', async (data: any) => {
      await createPeerConnection(data.from);
      await applyRemoteDescription(data.from, data.offer);
    });

    socket.on('answer', async (data: any) => {
      await applyRemoteDescription(data.from, data.answer);
    });

    socket.on('ice-candidate', async (data: any) => {
      const pc = peersRef.current.get(data.from);
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('添加 ICE 候选失败:', err);
      }
    });

    socket.on('playback-start', (data: any) => {
      setIsPlaying(true);
      isPlayingRef.current = true;
      // 【原生控制条】本场已开播，观众端提示文案切换到「房主已暂停」口径
      setScreeningStarted(true);
      setResolution(data?.resolution || null);
      if (data?.videoUrl) {
        // 网络视频模式：观众各自加载直链，不经过房主带宽。
        // 先清掉 srcObject：若上一场是本地文件（WebRTC）模式，<video> 上仍挂着 srcObject，
        // 按规范 srcObject 优先于 src，不清掉则 src 设置不生效，观众会一直卡在旧流画面。
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        setRemotePlayUrl(data.videoUrl);
        loadRemoteVideo(data.videoUrl, !!data.isHls);
      } else {
        setRemotePlayUrl('');
        destroyHls();
        // 【C3】观众端的播放失败必须留出口，不能直接吞掉
        playViewerVideo(remoteVideoRef.current);
      }
    });

    socket.on('playback-pause', () => {
      setIsPlaying(false);
      isPlayingRef.current = false;
      remoteVideoRef.current?.pause();
      localVideoRef.current?.pause();
    });

    socket.on('playback-resume', () => {
      setIsPlaying(true);
      isPlayingRef.current = true;
      setScreeningStarted(true);
      playViewerVideo(remoteVideoRef.current);
      localVideoRef.current?.play().catch(() => {});
    });

    socket.on('playback-stop', () => {
      setIsPlaying(false);
      isPlayingRef.current = false;
      // 本场放映已结束：观众端文案回到「等待房主开始播放」
      setScreeningStarted(false);
      // 房主端还要把画面与播放源一起清掉（结束放映 = 播放源作废）。
      // 用 isHostRef 判断：观众端调 clearHostVideo 会误清自己的元素。
      if (isHostRef.current) {
        resetHostPlaybackUi();
      }
      remoteVideoRef.current?.pause();
      localVideoRef.current?.pause();
    });

    // 【播放源持久化】服务端确认「播放源已写入房间记录」，给房主一个明确的成功反馈。
    // 服务端校验失败（非法协议/超长）时会走 error 事件，这里只处理成功回执。
    socket.on('source-saved', (data: any) => {
      if (typeof data?.videoUrl === 'string' && data.videoUrl) {
        setRemotePlayUrl(data.videoUrl);
        setUsingRemoteUrl(true);
        usingRemoteUrlRef.current = true;
      }
      setSourceSavedTip(true);
      if (sourceSavedTimerRef.current) clearTimeout(sourceSavedTimerRef.current);
      sourceSavedTimerRef.current = window.setTimeout(() => setSourceSavedTip(false), 3000);
    });

    // 房主拖动进度条 seek 后，观众跟随 seek（进度差拉大的主因修复）。
    socket.on('playback-seek', (data: any) => {
      const el = remoteVideoRef.current;
      const t = typeof data?.currentTime === 'number' ? data.currentTime : 0;
      if (el && Number.isFinite(t)) {
        lastViewerSeekRef.current = Date.now();
        try { el.currentTime = t; } catch {}
      }
    });

    // 周期温和纠偏：房主每 2 秒广播进度，观众只在进度差 > 2 秒时才 seek，
    // 且带 3 秒冷却 + 跳过缓冲中，避免旧版「每 2 秒无差别 seek」反复打断 HLS 缓冲导致卡顿。
    // 正常播放时房主观众播放同一 HLS、进度差 < 1 秒，几乎不触发 seek，保持流畅。
    socket.on('progress-sync', (data: any) => {
      const el = remoteVideoRef.current;
      const t = typeof data?.currentTime === 'number' ? data.currentTime : 0;
      if (!el || !Number.isFinite(t)) return;
      // 加入后前 5 秒内不纠偏，避免初始加载/缓冲期间被 seek 打断
      if (Date.now() - viewerJoinedAtRef.current < 5000) return;
      // 冷却期内不重复 seek
      if (Date.now() - lastViewerSeekRef.current < 3000) return;
      // 正在缓冲 / seek 中，跳过本轮
      if (el.seeking || el.readyState < 2) return;
      // 进度差超过 2 秒才纠正
      if (Math.abs(el.currentTime - t) > 2) {
        lastViewerSeekRef.current = Date.now();
        try { el.currentTime = t; } catch {}
      }
    });

    socket.on('host-disconnected', (data: any) => {
      setIsPlaying(false);
      isPlayingRef.current = false;
      appendSystemMessage(`⚠️ ${data.message || '房主连接中断，放映已结束'}`);
    });

    socket.on('chat-message', (msg: ChatMessage) => {
      appendMessage(msg);
    });

    socket.on('chat-limited', (data: any) => {
      appendSystemMessage(`⏱️ ${data.message}`);
    });

    socket.on('voice-state', (data: any) => {
      if (!data.userId) return;
      setVoiceUserIds(prev => {
        const next = new Set(prev);
        if (data.inVoice) next.add(data.userId);
        else next.delete(data.userId);
        return next;
      });
    });

    socket.on('user-speaking', (data: any) => {
      if (!data.userId) return;
      if (data.speaking) {
        setSpeakingUserIds(prev => new Set(prev).add(data.userId));
        const lvl = typeof data.level === 'number' ? Math.max(0, Math.min(1, data.level)) : 1;
        setLevelByUser(prev => ({ ...prev, [data.userId]: lvl }));
      } else {
        setSpeakingUserIds(prev => {
          const next = new Set(prev);
          next.delete(data.userId);
          return next;
        });
        setLevelByUser(prev => {
          const next = { ...prev };
          delete next[data.userId];
          return next;
        });
      }
    });

    // 房主踢出结果：从成员栏移除并提示
    socket.on('kick-result', (data: any) => {
      if (data.kicked) {
        setMembers(prev => prev.filter(m => m.userId !== data.targetUserId));
        setOnlineUserIds(prev => {
          const next = new Set(prev);
          next.delete(data.targetUserId);
          return next;
        });
        appendSystemMessage(`🚨 「${data.targetName}」已被房主踢出房间，5 小时内无法再次进入`);
      }
    });

    socket.on('kicked', (data: any) => {
      alert(data.reason || '你已被踢出该房间');
      if (isHostRef.current) { destroyHostSession(id!); hostSessionRef.current = null; }
      cleanupAll(true);
      navigate('/');
    });

    // 房间被彻底解散并清除（房主退出后自动解散），所有人退出到首页
    socket.on('room-dissolved', (data: any) => {
      alert(data.reason || '房间已解散并清除');
      if (isHostRef.current) { destroyHostSession(id!); hostSessionRef.current = null; }
      cleanupAll(true);
      navigate('/');
    });

    socket.on('error', (err: any) => {
      setError(err.message);
    });
  };

  // ===== WebRTC mesh =====

  const isPolite = (peerSocketId: string) => {
    const myId = socketRef.current?.id || '';
    return myId < peerSocketId;
  };

  const createPeerConnection = async (targetSocketId: string): Promise<RTCPeerConnection> => {
    const existing = peersRef.current.get(targetSocketId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peersRef.current.set(targetSocketId, pc);
    makingOfferRef.current.set(targetSocketId, false);
    isSettingRemoteAnswerPendingRef.current.set(targetSocketId, false);

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', {
          target: targetSocketId,
          candidate: event.candidate
        });
      }
    };

    // 发起一次协商。
    // 按「完美协商」模式实现：不再用 signalingState 做前置判断。
    // 旧的写法 `if (pc.signalingState !== 'stable') return;` 会把正在 have-remote-offer
    // 期间排队的 negotiationneeded 静默丢弃——观众端发的空 offer（0 个 m-line）会让房主
    // 回出一个同样没有媒体行的 answer，房主刚 addTrack 的本地视频轨因此永远协商不出去，
    // 观众端永久黑屏无声（且无任何自愈通道，必须刷新页面）。
    // 完美协商把这个责任交还给 setRemoteDescription：对方 offer 到达时若本端也有在途
    // offer，由 polite 的一方自动 rollback 并重新协商，不会被丢弃。
    const makeOffer = async () => {
      try {
        // 防抖：同一 peer 已有一次协商在途时不再并发，避免 description 类型错乱
        if (makingOfferRef.current.get(targetSocketId)) return;
        makingOfferRef.current.set(targetSocketId, true);
        await pc.setLocalDescription();
        const desc = pc.localDescription;
        if (!desc) return;
        // setLocalDescription 的产物不一定是 offer：若此刻恰好处于 have-remote-offer，
        // 它会生成 answer。按实际类型分发，保证信令语义正确。
        if (desc.type === 'offer') {
          socketRef.current?.emit('offer', { target: targetSocketId, offer: desc });
        } else if (desc.type === 'answer') {
          socketRef.current?.emit('answer', { target: targetSocketId, answer: desc });
        }
      } catch (err) {
        console.error('协商失败:', err);
      } finally {
        makingOfferRef.current.set(targetSocketId, false);
      }
    };
    makeOfferRef.current.set(targetSocketId, makeOffer);

    pc.onnegotiationneeded = () => {
      void makeOffer();
    };

    pc.ontrack = (event) => {
      handleRemoteTrack(targetSocketId, event.track);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        removePeer(targetSocketId);
      }
    };

    // 【C1 根治】观众端 + 本地文件 WebRTC 模式：先声明「只收不发」的收发器。
    // 这样观众发出的第一个 offer 就携带 audio/video 两个 m-line，房主随后 addTrack 的
    // 本地视频/音频轨能被直接关联到这两条轨道上，一次往返即可完成媒体协商，
    // 不再依赖「先答一个空 answer、再补发 offer」的二次协商，从根上消除黑屏。
    // 网络直链模式不声明：该模式下视频不经过 WebRTC，只会白白占用收发器。
    if (!isHostRef.current && !usingRemoteUrlRef.current) {
      try {
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
      } catch { /* 不支持 addTransceiver 的环境退化为原行为 */ }
    }

    addLocalTracksTo(pc);

    // 兜底：确保本端一定会主动发出一次 offer。
    // addTransceiver / addTrack 会把 negotiationneeded 排入任务队列，正常情况下由
    // onnegotiationneeded 发起；但个别浏览器在「同步创建 PC」窗口内的 add 操作存在
    // 不派发该事件的边缘情况，届时双方都在等对方先开口 → 永久黑屏。
    // 延迟一个任务补发一次；makeOffer 内部有防抖，重复调用安全无害。
    setTimeout(() => { void makeOffer(); }, 0);

    return pc;
  };

  const addLocalTracksTo = (pc: RTCPeerConnection) => {
    if (localMicRef.current) {
      localMicRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localMicRef.current!);
      });
    }
  };

  /** 停止并移除某个 peer 单独创建的 Audio 元素（取消第二路播放） */
  const releaseAudioEl = (socketId: string) => {
    const el = audioElsRef.current.get(socketId);
    if (!el) return;
    try {
      el.pause();
      el.srcObject = null;
    } catch { /* ignore */ }
    audioElsRef.current.delete(socketId);
  };

  /**
   * 播放观众端视频，并处理浏览器的自动播放策略拦截。
   * 【C3】旧实现是 el.play().catch(() => {}) —— 被拒绝时静默吞掉，用户既不知道发生了什么，
   * 也没有任何可以自救的入口，表现就是「看得见画面但没声音」甚至直接黑屏。
   * 这里改为：带声音播放被拒 → 退化为静音自动播放（至少保证出画面），
   * 同时弹出「点击开启声音」浮层，用户点一次即可解锁。
   */
  /**
   * 观众端播放兜底。
   *
   * 重要：必须区分失败原因，不能「凡是 play() 失败就弹提示」。
   * play() 返回的 Promise 被 reject 有很多与自动播放策略无关的情形，最常见的是
   * AbortError —— 典型如先给 currentTime 赋值触发 seek、紧接着又调用 play()，
   * 浏览器会判定播放请求被新的加载请求打断而 reject。这类失败不需要任何兜底：
   * <video> 自带 autoPlay 属性，数据就绪后浏览器会自行起播。
   *
   * 只有 NotAllowedError 才是真正的「自动播放策略拦截」，需要静音兜底 + 提示解锁。
   * 早期版本对所有 reject 一律弹出全屏遮罩，导致中途加入的观众（会走进 seek 分支）
   * 明明视频能播，却被 0.7 不透明的遮罩整片糊住，表现为「黑屏且无提示」。
   */
  const playViewerVideo = (el: HTMLVideoElement | null) => {
    if (!el) return;
    const p: any = el.play();
    if (!p || typeof p.catch !== 'function') return;
    p.catch((err: any) => {
      if (err?.name !== 'NotAllowedError') return;
      el.muted = true;
      const p2: any = el.play();
      if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
      // 静音播放一般下一帧就能起播，这里延迟复核：确认画面真的在播了才提示解锁声音。
      // 否则视频因其他原因（源失效/网络错误）根本没起来时也会弹提示，误导用户。
      window.setTimeout(() => {
        const cur = remoteVideoRef.current;
        if (!cur) return;
        // 注意两种片源要一起判断：网络直链走 src（HLS 为 blob:），
        // 而本地文件的 WebRTC 流挂在 srcObject 上，此时 src 是空的。
        const hasSource = !!(cur.src || cur.srcObject);
        if (hasSource && !cur.paused && cur.readyState >= 2) {
          setNeedUnmute(true);
        }
      }, 600);
    });
  };

  /**
   * 【直链-1】非 HLS 直链加载失败时，降级为「走服务端代理」重试一次。
   *
   * 背景：为了不让所有视频都挤占服务器带宽，非 HLS 直链（mp4/webm 等）原本直接交给
   * `<video src>` 连源站。但 /api/video-proxy 存在的唯一目的，恰恰是伪造目标站的同源
   * Referer 来绕过防盗链校验——结果最受保护的 mp4 反而绕开了代理，遇到防盗链一律失败，
   * 用户只能看到「网络错误：直链不可达或已被服务器拒绝」，还以为是自己的链接不行。
   *
   * 这里改成「先直连、失败自动走代理」：无需代理的站点依旧享受直连 CDN 的带宽，
   * 带防盗链的站点则被自动救回。返回 true 表示已发起重试（调用方应放弃本次报错）。
   *
   * 【HLS 播放策略】HLS 一律本地直连、不走代理（见文件顶部说明），因此这里对 HLS 直接返回
   * false，不会把 HLS 拉回服务器中转。
   */
  const retryDirectViaProxy = (el: HTMLVideoElement | null): boolean => {
    if (!el) return false;
    // HLS 不走代理：hls.js 驱动时 el.src 是 blob: MediaSource，改 src 会打断 MSE；
    // Safari/iOS 的原生 HLS（<video src>）同样按策略保持直连，不做代理降级。
    if (directIsHlsRef.current) return false;
    const raw = directUrlRef.current;
    if (!raw || !/^https?:\/\//i.test(raw)) return false;
    // 当前 src 已经是代理地址 → 说明已经重试过且仍然失败，放弃避免来回震荡
    if (el.src.includes('/api/video-proxy')) return false;
    setVideoError('');
    el.src = toProxiedUrl(raw);
    return true;
  };

  /** 观众点击浮层解锁声音：解除静音并恢复播放 */
  const unlockViewerAudio = () => {
    const el = remoteVideoRef.current;
    if (!el) return;
    el.muted = false;
    el.play().catch(() => {});
    setNeedUnmute(false);
  };

  const handleRemoteTrack = (socketId: string, track: MediaStreamTrack) => {
    let stream = remoteStreamsRef.current.get(socketId);
    if (!stream) {
      stream = new MediaStream();
      remoteStreamsRef.current.set(socketId, stream);
    }
    if (!stream.getTracks().includes(track)) {
      stream.addTrack(track);
    }

    if (track.kind === 'video') {
      // 【C2】视频轨所在的流会被整体绑给 <video>，而 <video> 会连带播放这条流里的音轨。
      // 若音轨先于视频轨到达并已创建了独立的 Audio 元素，同一条流的声音就会被播放两遍
      // （双重声音 / 回声）。视频轨到达时撤掉该 Audio 元素，声音统一由 <video> 出。
      releaseAudioEl(socketId);
      // 关键修复：ontrack 可能在 React 渲染 <video>（remoteVideoRef 赋值）之前触发，
      // 此时 remoteVideoRef.current 为 null，直接跳过会导致视频轨永远没设置到元素上 → 黑屏。
      // 这里改为：元素未就绪时延迟重试，直到挂载后设置 srcObject。
      const applyVideo = (attempt = 0) => {
        const el = remoteVideoRef.current;
        if (!el) {
          // 重试加上限：元素长期不挂载（如组件已卸载/对端异常）时停止空转，避免无限 setTimeout 泄漏
          if (attempt >= 100) return;
          setTimeout(() => applyVideo(attempt + 1), 100);
          return;
        }
        if (el.srcObject !== stream) {
          el.srcObject = stream;
        }
        playViewerVideo(el);
      };
      applyVideo();
    } else if (track.kind === 'audio') {
      // 【C2】含视频轨的流，其声音已由 <video> 一并播放，此处不再单独播第二遍。
      // 只有纯语音流（麦克风，本身无视频轨）才需要单独的 Audio 元素播放。
      if (stream.getVideoTracks().length > 0) return;
      let audioEl = audioElsRef.current.get(socketId);
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        audioElsRef.current.set(socketId, audioEl);
      }
      audioEl.srcObject = stream;
      audioEl.play().catch(() => {});
    }
  };

  const removePeer = (socketId: string) => {
    const pc = peersRef.current.get(socketId);
    if (pc) {
      pc.close();
      peersRef.current.delete(socketId);
    }
    makingOfferRef.current.delete(socketId);
    isSettingRemoteAnswerPendingRef.current.delete(socketId);
    makeOfferRef.current.delete(socketId);
    remoteStreamsRef.current.delete(socketId);
    releaseAudioEl(socketId);
  };

  // ===== 直链获取（服务端嗅探）=====

  const openSniffInput = () => {
    setSniffInput('');
    setSniffError('');
    setSniffLoading(false);
    setShowSniffResult(false);
    setSniffUrls([]);
    setShowSniffInput(true);
  };

  const closeSniffInput = () => {
    if (sniffLoading) return;
    setShowSniffInput(false);
  };

  const generateDirectUrl = async () => {
    const url = sniffInput.trim();
    if (!/^https?:\/\//i.test(url)) {
      setSniffError('请输入以 http:// 或 https:// 开头的有效网址');
      return;
    }
    setSniffError('');
    setSniffLoading(true);
    try {
      const { data } = await api.get('/sniff', { params: { url } });
      const urls: string[] = Array.isArray(data?.urls) ? data.urls : [];
      setSniffUrls(urls);
      setSniffTitle(typeof data?.title === 'string' ? data.title : '');
      setCopiedUrl(null);
      // 关闭输入弹窗，弹出结果弹窗
      setShowSniffInput(false);
      setShowSniffResult(true);
    } catch (e: any) {
      setSniffError(e?.response?.data?.error || '获取直链失败，请确认网址可访问或稍后重试');
    } finally {
      setSniffLoading(false);
    }
  };

  const closeSniffResult = () => {
    setShowSniffResult(false);
    setSniffUrls([]);
  };

  const copySniffUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      // 复制成功后自动关闭结果弹窗
      setTimeout(() => {
        setShowSniffResult(false);
        setSniffUrls([]);
      }, 600);
    } catch {
      // 剪贴板不可用（非安全上下文等）：降级为选中文本让用户手动复制
      window.prompt('复制失败，请手动复制：', url);
    }
  };

  // ===== 语音聊天 =====

  const joinVoice = async () => {
    try {
      // 安全上下文检查：getUserMedia 在公网 HTTP（非 localhost / 非 HTTPS）下会被浏览器拒绝。
      // 提前给出明确提示，避免「点击无反应」。
      if (!navigator.mediaDevices?.getUserMedia) {
        alert('当前页面无法访问麦克风：浏览器仅在 HTTPS 或 localhost 安全环境下允许语音。\n请通过 HTTPS（如 https://你的域名）访问本网站后再加入语音。');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localMicRef.current = stream;
      setInVoice(true);
      setMicOn(true);
      micOnRef.current = true;

      peersRef.current.forEach(pc => {
        stream.getTracks().forEach(track => pc.addTrack(track, stream));
      });

      socketRef.current?.emit('voice-join', id);
      startSpeakingDetection(stream);
    } catch (error: any) {
      console.error('获取麦克风失败:', error);
      const name = error?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        alert('麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问后重试。');
      } else if (name === 'NotFoundError') {
        alert('未检测到麦克风设备，请检查设备连接。');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        alert('麦克风被其他应用占用，请关闭占用麦克风的程序后重试。');
      } else if (name === 'SecurityError') {
        alert('当前页面不是安全上下文（HTTP），浏览器禁止访问麦克风。\n请通过 HTTPS 访问本网站后再加入语音。');
      } else {
        alert('无法访问麦克风，请检查浏览器权限设置。');
      }
    }
  };

  const leaveVoice = () => {
    // 先记录麦克风轨道 id：下方移除 sender 时只能拔麦克风轨，
    // 不能用 kind==='audio' 无差别移除——否则会把房主推流的电影声音轨（WebAudio 分流）
    // 一并从所有 PC 拔掉，房主「加入语音→退出语音」后观众将永久失去电影声音。
    const micTrackIds = new Set((localMicRef.current?.getTracks() || []).map(t => t.id));
    if (localMicRef.current) {
      localMicRef.current.getTracks().forEach(t => t.stop());
      localMicRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    speakingRef.current = false;
    setInVoice(false);
    setSpeakingUserIds(prev => {
      const me = useAuthStore.getState().user;
      const next = new Set(prev);
      if (me) next.delete(me.id);
      return next;
    });
    socketRef.current?.emit('voice-leave', id);
    peersRef.current.forEach((pc) => {
      pc.getSenders().forEach(sender => {
        if (sender.track && micTrackIds.has(sender.track.id)) {
          pc.removeTrack(sender);
        }
      });
    });
  };

  const toggleMic = () => {
    if (!localMicRef.current) return;
    const next = !micOn;
    localMicRef.current.getAudioTracks().forEach(t => { t.enabled = next; });
    setMicOn(next);
    // 【C4】同步更新 ref：说话检测循环读的是 ref 而不是 state，否则「关麦 → 再开麦」后
    // 检测函数里的 micOn 永远是进入语音那一刻的旧值，说话高亮永久失效。
    micOnRef.current = next;
    if (!next) {
      emitSpeaking(false);
    }
  };

  const startSpeakingDetection = (stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const check = () => {
        if (!audioCtxRef.current) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        // 【C4】读 micOnRef 而非 micOn。check() 通过 setTimeout 永久自递归，
        // 闭包只捕获进入语音那一刻的渲染快照，读 state 会导致开关麦克风后判定失效。
        const speaking = micOnRef.current && avg > 12;
        // 归一化音量到 0~1（用于头像按音量着色：绿→黄→红）
        const level = Math.max(0, Math.min(1, avg / 80));
        if (speaking !== speakingRef.current) {
          speakingRef.current = speaking;
          emitSpeaking(speaking, level);
        } else if (speaking) {
          // 说话中持续上报音量等级
          emitSpeaking(true, level);
        }
        setTimeout(check, 200);
      };
      check();
    } catch (error) {
      console.error('说话检测初始化失败:', error);
    }
  };

  const emitSpeaking = (speaking: boolean, level = 0) => {
    socketRef.current?.emit('speaking', { roomId: id, speaking, level });
    const me = useAuthStore.getState().user;
    if (me) {
      if (speaking) {
        setSpeakingUserIds(prev => new Set(prev).add(me.id));
        setLevelByUser(prev => ({ ...prev, [me.id]: Math.max(0, Math.min(1, level)) }));
      } else {
        setSpeakingUserIds(prev => {
          const next = new Set(prev);
          next.delete(me.id);
          return next;
        });
        setLevelByUser(prev => {
          const next = { ...prev };
          delete next[me.id];
          return next;
        });
      }
    }
  };

  const toggleMuteUser = (userId: string) => {
    setMutedUserIds(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);

      const member = members.find(m => m.userId === userId);
      if (member?.socketId) {
        const audioEl = audioElsRef.current.get(member.socketId);
        if (audioEl) audioEl.muted = next.has(userId);
      }
      return next;
    });
  };

  // ===== 踢出（房主直接踢出，无需投票） =====

  const requestKick = (targetUserId: string) => {
    setMenuUserId(null);
    if (!socketRef.current) return;
    const target = members.find(m => m.userId === targetUserId);
    if (!target) return;
    if (!confirm(`确定要踢出「${target.nickname}」吗？\nTA 将立即被踢出，且 5 小时内无法再次进入。`)) return;
    socketRef.current.emit('kick-user', { roomId: id, targetUserId });
  };

  // ===== 聊天 =====

  // 弹幕轨道：随机垂直位置（避免全部重叠在同一高度）
  const pushDanmaku = (text: string) => {
    if (!text) return;
    const id = ++danmakuSeqRef.current;
    const top = Math.round((Math.random() * 82 + 6) * 10) / 10; // 6% ~ 88%
    // 【需求2】最高档放慢一倍（详见 speedToScrollDuration 的说明）
    const duration = speedToScrollDuration(danmakuSpeed);
    setDanmaku(prev => [...prev, { id, text, top, duration }]);
    window.setTimeout(() => {
      setDanmaku(prev => prev.filter(d => d.id !== id));
    }, duration * 1000 + 200);
  };

  const appendMessage = (msg: ChatMessage) => {
    // 去重：同用户同内容同时间戳在短时间内视为重复（防止监听器叠加导致重复弹幕）
    const sig = `${msg.userId}|${msg.message}|${msg.timestamp}`;
    if (msg.userId && recentMsgSigRef.current.has(sig)) return;
    if (msg.userId) {
      recentMsgSigRef.current.add(sig);
      setTimeout(() => recentMsgSigRef.current.delete(sig), 1500);
    }
    // 所有聊天内容以弹幕形式展示：非系统消息显示「昵称: 内容」
    pushDanmaku(`${msg.from}: ${msg.message}`);
  };

  const appendSystemMessage = (text: string) => {
    pushDanmaku(text);
  };

  const startCooldown = () => {
    setChatCooldown(CHAT_COOLDOWN_SEC);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      setChatCooldown(prev => {
        if (prev <= 1) {
          clearInterval(cooldownTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const sendMessage = () => {
    const text = chatInput.trim();
    if (!text || !socketRef.current || chatCooldown > 0) return;
    if (text.length > CHAT_MAX_LENGTH) return;

    socketRef.current.emit('chat-message', {
      roomId: id,
      message: text
    });

    const me = useAuthStore.getState().user;
    appendMessage({
      from: '我',
      userId: me?.id || '',
      message: text,
      timestamp: new Date().toISOString()
    });

    setChatInput('');
    startCooldown();
  };

  // ===== 网络视频（HLS / 直链）加载 =====
  const destroyHls = () => {
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch {}
      hlsRef.current = null;
    }
    // 同步清理持久化的 session.hls，避免它指向已销毁的实例（否则房主回来时
    // loadLocalUrl 的复用分支会误判为「仍在播放」而复用僵尸实例 → 黑屏）。
    if (hostSessionRef.current) {
      hostSessionRef.current.hls = null;
    }
  };

  /**
   * 【原生控制条】清空房主本地视频的「画面与元素状态」（「结束放映」时调用）。
   *
   * 「结束放映」= 本场作废 + 播放源清除（用户 2026-10-14 明确要求），
   * 所以这里不能只 pause()：必须把 src 摘掉，让视频区真正回到空白。
   * 否则画面停在最后一帧，且浏览器原生播放键仍能继续播放 —— 看起来就像「放映没结束」。
   */
  const clearHostVideo = () => {
    // 先落状态、开抑制窗口：摘 src / load() 会触发 pause、emptied 等事件，
    // 若不抑制会被 v.onpause 误判成「房主主动暂停」而向观众多广播一次 host-pause。
    hostScreenActiveRef.current = false;
    isPlayingRef.current = false;
    suppressPauseRef.current = Date.now();
    destroyHls();
    const el = hostSessionRef.current?.video || localVideoRef.current;
    if (el) {
      try { el.pause(); } catch {}
      el.removeAttribute('src');
      try { el.load(); } catch {}
    }
    directUrlRef.current = '';
    directIsHlsRef.current = false;
  };

  /**
   * 【原生控制条】「结束放映」后的本地清理：画面 + 播放源相关状态一起清空。
   * 与 clearHostVideo 分开是为了让服务端发来的 playback-stop（例如房间被解散）
   * 复用同一套清理，保证本地表现与库里「播放源已清除」一致。
   */
  const resetHostPlaybackUi = () => {
    clearHostVideo();
    setRemotePlayUrl('');
    setUrlInput('');
    setUsingRemoteUrl(false);
    usingRemoteUrlRef.current = false;
    setNeedClickPlay(false);
    setVideoError('');
    setProgress({ current: 0, duration: 0 });
    setIsPlaying(false);
  };

  /**
   * 判断一个直链是否为 HLS 流。
   * 除了 .m3u8 扩展名，还覆盖常见的无扩展名 HLS 直链特征：
   *   - 路径含 .m3u8
   *   - query 含 m3u8 / hls / .ts 等关键字（很多 CDN 直链不带扩展名）
   * 这样能避免把 HLS 播放列表误当普通 mp4 塞给 <video>（后者必然加载失败）。
   */
  function looksLikeHls(url: string): boolean {
    if (/\.m3u8(\?|#|$)/i.test(url)) return true;
    // 只取路径部分（去掉 query 与 hash）
    let pathPart = '';
    try {
      pathPart = new URL(url).pathname;
    } catch {
      pathPart = url;
    }
    // 【直链-2】只看「最后一个路径段」。
    //
    // 曾在结尾判定里加入 `/` 想兼容 `https://cdn/hls/` 这类以斜杠收尾的 HLS 地址，
    // 但这是错的：斜杠在 URL 路径里无处不在，根本不能当「结尾」用。实测把
    // `https://cdn/hls/movie.mp4`、`https://cdn/m3u8/movie.mp4` 这类真实 CDN 直链
    // 全部误判成 HLS（路径里有 hls/、m3u8/ 目录名，文件其实是 mp4），
    // hls.js 去解析一个 mp4 二进制必然失败 → 黑屏。误判率反而从 3/14 升到 5/14。
    //
    // 正确做法是先去掉末尾斜杠再取末段，两种场景同时覆盖：
    //   /hls/           → 末段 hls        → HLS ✅
    //   /hls/movie.mp4  → 末段 movie.mp4  → 非 HLS ✅
    //   /live/a.m3u8/   → 末段 a.m3u8     → HLS ✅
    const lastSeg = pathPart.replace(/\/+$/, '').split('/').pop() || '';
    return /(\.m3u8|m3u8|hls|\.ts)$/i.test(lastSeg);
  }

  /**
   * 用 hls.js 加载 HLS 流。
   * 关键点：必须在 manifest 解析完成（MANIFEST_PARSED）之后才调用 play()，
   * 否则在 attachMedia 之后立即 play() 会因媒体尚未就绪而静默失败。
   *
   * 【HLS 播放策略】url 始终是「原始直链」，由观众/房主本地网络直连源站，不经服务器中转
   * （见文件顶部策略说明）。直连失败不做代理降级，而是重试若干次后给出明确提示。
   */
  const attachHls = (el: HTMLVideoElement, url: string, seekTo?: number) => {
    // 关键优化：通过 config.startPosition 让 hls.js 加载时直接从目标位置定位、只拉该位置
    // 附近的分片，跳过「从 0 缓冲一遍再 seek 到目标」的双重缓冲，观众中途进入可秒开。
    const hls = new Hls(
      typeof seekTo === 'number' && seekTo > 0 ? { startPosition: seekTo } : {}
    );
    hlsRef.current = hls;
    // 每次建立新实例都归零重试计数，否则换片/重连的历史次数会累积，把偶发抖动误判成致命错误
    hlsRetryRef.current = 0;
    // 房主：HLS 实例持久化到 session.hls，房主切页后 hlsRef（组件级）随组件卸载丢失，
    // 但 session.hls 仍持有实例继续拉流播放；房主回来时 loadLocalUrl 会复用同一实例，
    // 避免在同一个 session.video 上叠加新旧两个 HLS 实例导致冲突（黑屏）。
    if (isHostRef.current && hostSessionRef.current) {
      hostSessionRef.current.hls = hls;
    }
    hls.loadSource(url);
    hls.attachMedia(el);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setVideoError('');
      // manifest 成功解析说明链路已恢复，归零网络重试计数，
      // 避免后续偶发抖动累加到上限后被误报成「直链失效」
      hlsRetryRef.current = 0;
      // 【C3】观众端播放失败需静音兜底 + 提示解锁声音；房主端保留点击播放兜底。
      //
      // 顺序要紧：必须先 play 再 seek。startPosition 已完成定位，下面这次 currentTime
      // 赋值只是兜底。若把它放在 play() 之前，seek 会打断刚发起的播放请求并让 play()
      // 抛 AbortError —— 而这只有「中途加入（seekTo > 0）」的观众才会走到，
      // 于是表现成「放映途中加入的人被弹遮罩黑屏，房主本人却完全正常」。
      if (el === remoteVideoRef.current) {
        playViewerVideo(el);
      } else {
        el.play().catch(() => setNeedClickPlay(true));
      }
      // 兜底 seek：仅当位置确实偏了才纠正，避免无谓的 seek 打扰刚发起的播放
      if (typeof seekTo === 'number' && seekTo > 0 && Math.abs(el.currentTime - seekTo) > 1) {
        try { el.currentTime = seekTo; } catch {}
      }
    });
    hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
      if (!data?.fatal) return;
      console.error('HLS 播放错误：', data);
      // 网络错误时先尝试自动恢复，避免临时抖动直接判死。
      // 但必须设上限：直链失效/过期时 ERROR 会反复触发，无限重试意味着
      // 既播不出画面、又永远不给提示，用户只能对着黑屏干等。
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hlsRetryRef.current += 1;
        if (hlsRetryRef.current <= 3) {
          hls.startLoad();
          return;
        }
        // 【HLS 播放策略】本地直连失败后不会降级走服务器代理，所以这里必须把原因讲清楚，
        // 否则用户只会看到「网络错误」。hls.js 把跨域拦截与防盗链 403 都归为 NETWORK_ERROR
        // （含 MANIFEST_PARSING_ERROR），这两种是本地直连失败最常见的两个原因。
        setVideoError(
          '视频加载失败：无法从本地网络直接访问该 HLS 直链。' +
          '常见原因：① 源站未开放跨域（未返回 Access-Control-Allow-Origin），浏览器会拦下 hls.js 的请求；' +
          '② 源站做了防盗链 Referer 校验；③ 直链已失效或过期。' +
          '提示：当前 HLS 为「本地直连」模式，不经过服务器中转，因此这类源站无法播放，换一个可直连的链接即可。'
        );
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hlsRetryRef.current += 1;
        if (hlsRetryRef.current <= 3) {
          hls.recoverMediaError();
          return;
        }
      }
      setVideoError('视频加载失败：HLS 流解析出错。请确认直链有效且未过期（多数站点直链有时效），重试或更换链接。');
      // 观众端不显示点击播放按钮
      if (el !== remoteVideoRef.current) {
        setNeedClickPlay(true);
      }
    });
  };

  const loadRemoteVideo = (url: string, isHls: boolean, seekTo?: number) => {
    const el = remoteVideoRef.current;
    // 关键修复：room-joined 回调可能在 React 渲染 <video>（remoteVideoRef 赋值）之前
    // 就执行，此时 el 为 null，直接 return 会导致观众中途加入时画面永远不加载 → 黑屏。
    // 这里改为延迟重试，直到 video 元素挂载就绪。
    if (!el) {
      // 【直链-5】同一时刻只允许存在一条待重试的请求：先清掉上一条尚未触发的定时器。
      // 旧实现无条件 setTimeout 递归，room-joined 与 playback-start 若在 <video> 挂载前
      // 先后到达，就会并存两条互不感知的重试链，各自执行 destroyHls + attachHls，
      // 最终在同一个 <video> 上叠加多个 HLS 实例（旧实例成为孤儿，后台持续拉分片）。
      if (viewerLoadTimerRef.current) clearTimeout(viewerLoadTimerRef.current);
      viewerLoadTimerRef.current = setTimeout(() => {
        viewerLoadTimerRef.current = null;
        loadRemoteVideo(url, isHls, seekTo);
      }, 100);
      return;
    }
    // 元素已就绪：作废仍在等待的重试定时器，确保只有本次加载真正生效
    if (viewerLoadTimerRef.current) {
      clearTimeout(viewerLoadTimerRef.current);
      viewerLoadTimerRef.current = null;
    }
    // 【直链-1】记录原始直链，供加载失败后降级走服务端代理重试使用
    directUrlRef.current = url;
    setVideoError('');
    destroyHls();
    // 增强 HLS 识别：显式标记 或 启发式判断
    const useHls = isHls || looksLikeHls(url);
    directIsHlsRef.current = useHls;
    // 【HLS 播放策略】HLS 一律由本地网络直连源站，不走服务器代理（见文件顶部说明），
    // 失败时不做代理降级，由 attachHls 重试若干次后给出明确提示。
    // 非 HLS 直链同样先直连源站；被防盗链拒绝时由 onError → retryDirectViaProxy 降级走代理一次。
    const target = url;
    const applySeekAndPlay = (e: HTMLVideoElement) => {
      if (typeof seekTo === 'number' && seekTo > 0) {
        if (e.readyState >= 1) {
          try { e.currentTime = seekTo; } catch {}
          playViewerVideo(e);
        } else {
          e.addEventListener('loadedmetadata', () => {
            try { e.currentTime = seekTo; } catch {}
            playViewerVideo(e);
          }, { once: true });
        }
      } else {
        playViewerVideo(e);
      }
    };
    if (useHls && Hls.isSupported()) {
      // 传「原始直链」：由 attachHls 自行决定直连 / 代理，并在直连失败时自动降级重试
      attachHls(el, url, seekTo);
    } else if (useHls && el.canPlayType('application/vnd.apple.mpegurl')) {
      // 原生 HLS 支持（Safari）：直接交给 <video>
      el.src = target;
      applySeekAndPlay(el);
    } else {
      el.src = target;
      applySeekAndPlay(el);
    }
  };

  // 房主本地也直接加载网络视频观看（不通过 WebRTC 转发）
  const loadLocalUrl = (url: string, isHls: boolean, seekTo?: number) => {
    const el = hostSessionRef.current?.video || localVideoRef.current;
    if (!el) return;
    setVideoError('');
    const useHls = isHls || looksLikeHls(url);
    // 【直链-1】房主端同样记录原始直链与 HLS 标记。
    directUrlRef.current = url;
    directIsHlsRef.current = useHls;
    // 【HLS 播放策略】HLS 一律由本地网络直连源站，不走服务器代理（见文件顶部说明）。
    // 非 HLS 直链（mp4/webm 等）同样先直连源站，不经过服务器代理、充分利用 CDN 带宽；
    // 失败时由 v.onerror → retryDirectViaProxy 降级走代理重试一次。
    const target = url;

    // 房主切页回来：若 session.hls 仍存活、attach 在同一个 video 上、且加载的还是同一
    // 条直链（url 一致），说明切页期间 HLS 一直在后台播放、进度持续推进。此时直接复用，
    // 不 destroy、不重新 loadSource、不重新 attachMedia，避免在同一个 video 上叠加新旧
    // 两个 HLS 实例导致冲突（黑屏）。
    // 注意必须校验 url：若房主主动切换了新的直链，existingHls.url 与 target 不同，不能复用
    // 旧 HLS（否则会继续放旧片源），应走下方 destroyHls + 重新加载新直链的正常流程。
    // 用 target（而非裸 url）比较：直连失败降级后实例记录的是代理地址，若再拿裸 url 比较
    // 会永远不相等 → 每次切页回来都重建实例，白白重新缓冲。
    const existingHls = hostSessionRef.current?.hls;
    if (existingHls && existingHls.media === el && existingHls.url === target) {
      hlsRef.current = existingHls;
      el.play().catch(() => setNeedClickPlay(true));
      return;
    }

    destroyHls();
    // 房主切页回来重载直链时，加载完成后追回原进度（否则会从 0 重新播放，进度与观众脱节）
    const resumeAt = (e: HTMLVideoElement) => {
      if (typeof seekTo === 'number' && seekTo > 0) {
        const apply = () => {
          try { e.currentTime = seekTo; } catch {}
          e.play().catch(() => setNeedClickPlay(true));
        };
        if (e.readyState >= 1) apply();
        else e.addEventListener('loadedmetadata', apply, { once: true });
      } else {
        e.play().catch(() => setNeedClickPlay(true));
      }
    };
    if (useHls && Hls.isSupported()) {
      // 传「原始直链」：由 attachHls 自行决定直连 / 代理，并在直连失败时自动降级重试
      attachHls(el, url, seekTo);
    } else if (useHls && el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = target;
      resumeAt(el);
    } else {
      el.src = target;
      resumeAt(el);
    }
  };

  /** 手动点击「开始播放」：同时覆盖房主(localVideoRef)与观众(remoteVideoRef)两种情况 */
  const playCurrentVideo = () => {
    const el = isHostRef.current
      ? (hostSessionRef.current?.video || localVideoRef.current)
      : remoteVideoRef.current;
    el?.play().catch(() => setNeedClickPlay(true));
    setNeedClickPlay(false);
    setVideoError('');
  };

  const getResolution = () => {
    const el = hostSessionRef.current?.video || localVideoRef.current;
    if (el && el.videoWidth && el.videoHeight) return `${el.videoWidth}×${el.videoHeight}`;
    return null;
  };

  /**
   * 【直链-3】从直链推导一个可读的「片名」。
   * 旧实现直接把整条 URL 当作 movieName 广播 + 落库，导致房间列表、我的房间、
   * 个人中心、后台房间管理全都显示成一长串 URL（currentMovie 字段的数据来源就是它）。
   */
  const deriveMovieName = (url: string): string => {
    try {
      const u = new URL(url);
      const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      const cleaned = seg.replace(/\.(m3u8|mp4|webm|flv|mkv|mov)$/i, '').trim();
      // 排除纯数字/哈希式的 CDN 文件名（如 20240512_1f3a9c），这类名字没有可读性，不如给兜底名
      if (cleaned && /[a-z\u4e00-\u9fa5]/i.test(cleaned)) return cleaned.slice(0, 200);
    } catch { /* URL 解析失败走兜底 */ }
    return '网络视频直链';
  };

  /** 【直链-3】优先使用「🔗 直链获取」抓到的页面标题，否则回落到 URL 推导 */
  const resolveRemoteMovieName = (url: string): string => {
    if (sniffTitle && sniffUrls.includes(url)) return sniffTitle.slice(0, 200);
    return deriveMovieName(url);
  };

  // ===== 网络直链播放（房主端）：加载直链并广播给观众各自加载 =====
  const startRemotePlayback = () => {
    const url = remotePlayUrl.trim();
    if (!url) { alert('请先粘贴要播放的网络视频地址'); return; }
    // 增强 HLS 识别：不再只认 .m3u8，覆盖无扩展名的 HLS 直链
    const isHls = looksLikeHls(url);
    setIsPlaying(true);
    isPlayingRef.current = true;
    // 【原生控制条】本场放映开始：此后房主用浏览器原生控制条做的暂停/播放
    // 才算「本场的暂停/播放」，需要广播给观众。
    hostScreenActiveRef.current = true;
    loadLocalUrl(url, isHls);
    socketRef.current?.emit('host-start-play', {
      roomId: id,
      // 【直链-3】不再把整条 URL 当片名
      movieName: resolveRemoteMovieName(url),
      videoUrl: url,
      isHls,
      resolution: getResolution()
    });
  };

  // 播放入口：现仅支持网络视频直链播放
  const startPlayback = () => {
    startRemotePlayback();
  };

  // 暂停/继续由房主直接操作视频原生控制条（v.onpause / v.onplay 广播 host-pause / host-resume）。
  // 网页端不再自绘播放/暂停按钮或暂停遮罩。
  // 结束放映也由房主一键操作（已删除观众投票机制）。

  // 结束放映（房主一键结束，无需观众投票）
  // 【原生控制条】结束放映 = 本场作废 + 播放源清除：先本地清空画面与播放源状态，
  // 再通知服务端清库（rooms.sourceUrl 等置空）。两者保持一致，房主要再看需重新粘贴直链。
  const stopPlayback = () => {
    if (!socketRef.current) return;
    resetHostPlaybackUi();
    socketRef.current.emit('host-stop-play', { roomId: id });
  };

  // ===== 全屏观看 =====

  const enterFullscreen = async () => {
    const el = videoContainerRef.current;
    if (!el) return;
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if ((el as any).webkitRequestFullscreen) {
        (el as any).webkitRequestFullscreen(); // iOS Safari
      }
    } catch (err) {
      console.error('进入全屏失败:', err);
    }
  };

  const exitFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if ((document as any).webkitFullscreenElement) {
        (document as any).webkitExitFullscreen();
      }
    } catch (err) {
      console.error('退出全屏失败:', err);
    }
  };

  // 观众端进度条：显示并重置 3 秒自动隐藏定时器
  const pokeViewerBar = () => {
    if (isHost) return;
    setShowViewerBar(true);
    if (viewerBarTimerRef.current) clearTimeout(viewerBarTimerRef.current);
    viewerBarTimerRef.current = window.setTimeout(() => setShowViewerBar(false), 3000);
  };

  const toggleFullscreen = () => {
    if (isFullscreen) exitFullscreen();
    else enterFullscreen();
  };

  // 监听全屏状态变化（含用户按 Esc 退出全屏），同步 UI 状态
  useEffect(() => {
    const onFsChange = () => {
      const fsEl = document.fullscreenElement || (document as any).webkitFullscreenElement;
      setIsFullscreen(!!fsEl);
      if (!fsEl) setShowOverlayChat(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, []);

  const leaveRoom = async () => {
    // 房主拥有随时解散权（放映途中也可解散），观众为离开房间
    if (socketRef.current) {
      socketRef.current.emit('leave-room', id);
    }
    // 房主主动离开：彻底销毁推流会话（socket + 本地视频 + WebRTC peers + captureStream）。
    // 注意顺序：先 emit leave-room 再销毁，确保服务端收到离开信号。
    if (isHost) {
      destroyHostSession(id!);
      hostSessionRef.current = null;
    }
    cleanupAll(true);

    try {
      await api.post(`/rooms/${id}/leave`);
    } catch (error: any) {
      console.error('离开房间失败:', error);
      if (isHost) {
        alert(error.response?.data?.error || '解散房间失败');
        return;
      }
    }

    navigate('/');
  };

  // 电影播放完毕（仅房主触发）：暂停同步 + 房间回到等待状态 + 弹窗询问是否解散
  const handleHostMovieEnded = () => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    socketRef.current?.emit('host-pause', { roomId: id });
    // 房间状态回到等待，房主可开始新电影或解散房间
    api.patch(`/rooms/${id}/status`, { status: 'WAITING' }).catch(() => {});
    setEndedPrompt(true);
  };

  // ===== 渲染 =====

  if (loading) {
    return <div className="loading-page">加载中...</div>;
  }

  if (error && !room) {
    return <div className="error-page">{error}</div>;
  }

  const myUserId = user?.id;
  const roomImages = parseImages(room?.images);

  return (
    <div className="room-view-page fade-in">
      {/* 【需求4A】管理员广播条由 Layout 统一渲染（房间页 + 大厅共用），此处不再重复渲染 */}

      {/* 未加入状态 */}
      {!joined ? (
        <div className="join-room-card card">
          <h2>🎬 {room?.name}</h2>
          {room?.description && <p className="room-description">{room.description}</p>}

          {/* 房间图片展示 */}
          {roomImages.length > 0 && (
            <div className="join-room-gallery">
              {roomImages.map((img, idx) => (
                <img key={idx} src={img} alt={`房间图片 ${idx + 1}`} />
              ))}
            </div>
          )}

          <div className="room-info">
            <p>👤 房主：{room?.host.nickname || room?.host.username}</p>
            <p>👥 观众：{room?.members.length}/{room?.maxViewers}</p>
            {room?.hasPassword && !isHost && !user?.isAdmin && <p>🔒 需要密码</p>}
          </div>

          {room?.hasPassword && !isHost && !user?.isAdmin && (
            <div className="form-group">
              <label className="label">输入房间密码</label>
              <input
                type="password"
                className="input"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="请输入密码"
              />
            </div>
          )}

          {error && <div className="error-message">{error}</div>}

          <button
            onClick={handleJoin}
            className="btn btn-primary btn-block"
          >
            加入房间
          </button>

          <button onClick={() => navigate('/')} className="btn btn-secondary btn-block" style={{ marginTop: '12px' }}>
            返回列表
          </button>
        </div>
      ) : (
        /* 已加入 - 观影界面 */
        <div className="viewing-room">
          {/* 左侧：观众头像栏 */}
          <div className="avatar-rail">
            {members.map(member => {
              const isMe = member.userId === myUserId;
              const isMemberHost = member.userId === room?.hostId;
              const speaking = speakingUserIds.has(member.userId);
              const muted = mutedUserIds.has(member.userId);
              const inVoiceNow = voiceUserIds.has(member.userId) || (isMe && inVoice);

              return (
                <div key={member.userId} className="avatar-rail-item">
                  {(() => {
                    const lvl = speaking ? levelByUser[member.userId] : undefined;
                    const speakColor = lvl != null ? speakingColor(lvl) : undefined;
                    return (
                      <div
                        className={`avatar-circle ${speaking ? 'speaking' : ''} ${isMemberHost ? 'host' : ''} ${!onlineUserIds.has(member.userId) && !isMe ? 'offline' : ''}`}
                        style={{
                          backgroundColor: avatarColor(member.userId),
                          ...(speakColor ? { borderColor: speakColor, boxShadow: `0 0 12px ${speakColor}` } : undefined)
                        }}
                        title={member.nickname}
                        onClick={(e) => {
                          if (isMe) return;
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setMenuRect({ x: r.right + 6, y: r.top });
                          setMenuUserId(menuUserId === member.userId ? null : member.userId);
                        }}
                      >
                        {isMemberHost && <span className="host-crown">👑</span>}
                        {muted && <span className="mute-badge">🔇</span>}
                        {inVoiceNow && !muted && <span className="voice-badge">🎤</span>}
                      </div>
                    );
                  })()}
                  <span className="avatar-name">{isMe ? '我' : member.nickname}</span>
                </div>
              );
            })}
          </div>

          {/* 中间：视频区域 */}
          <div className="video-area">
            <div
              className="video-container"
              ref={videoContainerRef}
              onMouseMove={pokeViewerBar}
              onClick={pokeViewerBar}
            >
              {isHost ? (
                // 房主本地视频：使用模块级单例元素（session.video），跨页面切换存活。
                // 挂载由 useEffect（见 hostVideoMountEffect）在 session 就绪后执行，
                // 因为 session 是在 doJoin -> setupWebSocket 里才创建的，晚于首次渲染。
                <div
                  ref={hostVideoMountRef}
                  className="video-player"
                  style={{ width: '100%', height: '100%' }}
                />
              ) : (
                <video
                  ref={remoteVideoRef}
                  className="video-player"
                  autoPlay
                  playsInline
                  onTimeUpdate={(e) => {
                    const el = e.currentTarget;
                    setProgress({ current: el.currentTime, duration: el.duration || 0 });
                  }}
                  onLoadedMetadata={(e) => {
                    const el = e.currentTarget;
                    setProgress({ current: el.currentTime, duration: el.duration || 0 });
                  }}
                  onDurationChange={(e) => {
                    const el = e.currentTarget;
                    setProgress({ current: el.currentTime, duration: el.duration || 0 });
                  }}
                  onError={() => {
                    // 【直链-1】直连失败先降级走服务端代理重试（伪造同源 Referer 绕过防盗链）
                    if (retryDirectViaProxy(remoteVideoRef.current)) return;
                    const code = remoteVideoRef.current?.error?.code;
                    let msg = '视频加载失败，请检查网络链接是否有效、是否支持跨域播放';
                    if (code === MediaError.MEDIA_ERR_NETWORK) msg = '网络错误：直链不可达或已被服务器拒绝（防盗链/失效/跨域）';
                    else if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) msg = '格式不支持：该直链无法播放，或 HLS 流未被正确识别';
                    setVideoError(`${msg}。多数站点直链有时效，请重试或更换链接。`);
                  }}
                  /* 观众只读：不提供播放控制条，放映由房主统一控制 */
                />
              )}

              {resolution && (
                <div className="res-badge">{resolution}</div>
              )}

              {/* 弹幕层：所有聊天内容以弹幕形式从右向左滚动，覆盖在视频上方 */}
              <div className="danmaku-layer" style={{ opacity: danmakuOpacity }}>
                {danmaku.map(d => (
                  <div
                    key={d.id}
                    className="danmaku-item"
                    style={{
                      top: `${d.top}%`,
                      color: danmakuColor,
                      animationDuration: `${d.duration}s`
                    }}
                  >
                    {d.text}
                  </div>
                ))}
              </div>

              {/* 观众端只读进度条：原生 <progress> + 时间文本，不可拖动。
                  鼠标移动/点击时显示，3 秒无操作自动淡出，避免常驻影响观感。 */}
              {!isHost && isPlaying && (
                <div className={`viewer-progress ${showViewerBar ? 'visible' : ''}`}>
                  <progress
                    className="viewer-progress-bar"
                    max={progress.duration > 0 ? progress.duration : 1}
                    value={progress.current}
                  />
                  <span className="viewer-progress-time">
                    {formatTime(progress.current)} / {formatTime(progress.duration)}
                  </span>
                </div>
              )}

              {/* 全屏切换按钮（观众 + 房主均可用） */}
              <button
                className="fullscreen-btn"
                onClick={toggleFullscreen}
                title={isFullscreen ? '退出全屏' : '全屏观看'}
              >
                {isFullscreen ? '⛶ 退出全屏' : '⛶ 全屏'}
              </button>

              {/* 全屏时：左下角圆形半透明气泡，点击打开弹幕设置 + 发送输入框 */}
              {isFullscreen && (
                <button
                  className={`fullscreen-bubble ${showOverlayChat ? 'active' : ''}`}
                  onClick={() => setShowOverlayChat(v => !v)}
                  title={showOverlayChat ? '收起弹幕设置' : '打开弹幕设置'}
                >
                  💬
                </button>
              )}

              {/* 全屏弹幕设置 + 发送：不再显示消息列表，聊天内容以弹幕呈现 */}
              {isFullscreen && showOverlayChat && (
                <div className="overlay-chat">
                  <div className="overlay-chat-header">
                    <span className="overlay-chat-title">💬 弹幕设置</span>
                    <button
                      className="overlay-chat-close"
                      onClick={() => setShowOverlayChat(false)}
                      title="收起"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="danmaku-settings">
                    <label className="danmaku-setting-row">
                      <span>不透明度</span>
                      <input
                        type="range"
                        min="0.2"
                        max="1"
                        step="0.05"
                        value={danmakuOpacity}
                        onChange={(e) => setDanmakuOpacity(Number(e.target.value))}
                      />
                    </label>
                    <label className="danmaku-setting-row">
                      <span>滚动速度</span>
                      <input
                        type="range"
                        min="1"
                        max="5"
                        step="1"
                        value={danmakuSpeed}
                        onChange={(e) => setDanmakuSpeed(Number(e.target.value))}
                      />
                    </label>
                    <div className="danmaku-setting-row">
                      <span>颜色</span>
                      <div className="danmaku-colors">
                        {[
                          { c: '#ff4d4f', n: '红' },
                          { c: '#fadb14', n: '黄' },
                          { c: '#1677ff', n: '蓝' },
                          { c: '#52c41a', n: '绿' }
                        ].map(o => (
                          <button
                            key={o.c}
                            className={`danmaku-color ${danmakuColor === o.c ? 'active' : ''}`}
                            style={{ backgroundColor: o.c }}
                            title={o.n}
                            onClick={() => setDanmakuColor(o.c)}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="overlay-chat-input">
                    <input
                      type="text"
                      className="input chat-input"
                      value={chatInput}
                      maxLength={CHAT_MAX_LENGTH}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                      placeholder={`发送弹幕（最多 ${CHAT_MAX_LENGTH} 字）...`}
                    />
                    <button
                      onClick={sendMessage}
                      className="btn btn-primary btn-sm"
                      disabled={chatCooldown > 0 || !chatInput.trim()}
                    >
                      {chatCooldown > 0 ? `${chatCooldown}s` : '发送'}
                    </button>
                  </div>
                </div>
              )}

              {/* 【原生控制条】暂停提示（用户 2026-10-14 定稿）：
                  · 房主端**不再显示**「⏸ 已暂停」——暂停/播放状态一律由浏览器自带控制条
                    体现，网页自绘的遮罩会和原生控制条叠在一起。只有「还没设播放源」时
                    才给一句引导文案（此时视频区是空的，不存在重叠与状态错位）。
                  · 观众端没有原生控制条，仍需要文字提示：本场已开过 → 「房主已暂停」，
                    否则 → 「等待房主开始播放」。 */}
              {!isPlaying && (!isHost || !remotePlayUrl) && (
                <div className="video-overlay" style={{ pointerEvents: 'none' }}>
                  <p>
                    {isHost
                      ? '请粘贴视频直链并开始播放'
                      : (screeningStarted ? '⏸ 房主已暂停' : '等待房主开始播放')}
                  </p>
                </div>
              )}

              {(isHost && needClickPlay) && (
                <div className="video-overlay">
                  {videoError && (
                    <p style={{ color: '#ff6b6b', marginBottom: 12, maxWidth: 320 }}>{videoError}</p>
                  )}
                  <button
                    className="btn btn-primary"
                    onClick={playCurrentVideo}
                  >
                    ▶️ 点击开始播放（含声音）
                  </button>
                </div>
              )}

              {/* 【C3】观众端：自动播放被浏览器拦截时，视频已处于静音播放状态，这里提示解锁声音。
                  注意不能用上面的 needClickPlay —— 它的渲染条件带 isHost，观众侧永远不会显示。 */}
              {(!isHost && needUnmute) && (
                <div className="viewer-audio-tip">
                  <span>🔇 浏览器拦截了自动播放，当前静音播放中</span>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={unlockViewerAudio}
                  >
                    🔊 点击开启声音
                  </button>
                </div>
              )}
            </div>

            {/* 语音控制条 */}
            <div className="voice-controls">
              {inVoice ? (
                <>
                  <span className="voice-status on">🎤 语音聊天中</span>
                  <button onClick={toggleMic} className="btn btn-secondary btn-sm">
                    {micOn ? '🔇 关闭麦克风' : '🎤 打开麦克风'}
                  </button>
                  <button onClick={leaveVoice} className="btn btn-secondary btn-sm">
                    📞 退出语音
                  </button>
                </>
              ) : (
                <>
                  <span className="voice-status">未加入语音</span>
                  <button onClick={joinVoice} className="btn btn-primary voice-action-btn">
                    🎤 加入语音聊天
                  </button>
                  {isHost && (
                    <button onClick={openSniffInput} className="btn btn-primary voice-action-btn">
                      🔗 直链获取
                    </button>
                  )}
                </>
              )}
            </div>

            {/* 房主控制面板 */}
            {isHost && (
              <div className="host-controls">
                {/* 片源模式：现仅保留网络视频直链 */}
                <div className="source-tabs">
                  <button
                    className={`tab ${usingRemoteUrl ? 'active' : ''}`}
                    onClick={() => { setUsingRemoteUrl(true); usingRemoteUrlRef.current = true; }}
                  >🌐 网络视频直链</button>
                </div>

                <div className="url-play-row">
                  <span className="selected-file">📽️ {remotePlayUrl ? remotePlayUrl : '尚未设置播放源'}</span>
                  <input
                    className="input"
                    type="text"
                    placeholder="粘贴视频直链（支持 .m3u8 HLS 或 mp4/webm 等）"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                  />
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      const url = urlInput.trim();
                      if (!url) { alert('请先粘贴视频直链'); return; }
                      // 本地立即生效：输入框/播放按钮的可用状态
                      setRemotePlayUrl(url);
                      setUsingRemoteUrl(true);
                      usingRemoteUrlRef.current = true;
                      // 【播放源持久化】同时写入该房间的数据库记录：
                      // 此后暂停、结束放映、刷新页面、切页、服务重启都不会丢，
                      // 只有房间被解散时播放源才会随之消失。
                      socketRef.current?.emit('host-set-source', {
                        roomId: id,
                        videoUrl: url,
                        isHls: looksLikeHls(url),
                        resolution: getResolution()
                      });
                    }}
                  >
                    设为播放源
                  </button>
                  {sourceSavedTip && (
                    <span className="source-saved-tip">✅ 已保存到房间</span>
                  )}
                </div>

                {!isPlaying ? (
                  <button
                    onClick={startPlayback}
                    className="btn btn-success"
                    disabled={!remotePlayUrl.trim()}
                  >
                    ▶️ 播放网络视频
                  </button>
                ) : (
                  <>
                    {/* 暂停/继续改用视频原生控制条，此处仅保留结束放映 */}
                    <button
                      onClick={stopPlayback}
                      className="btn btn-secondary"
                    >
                      ⏹️ 结束放映
                    </button>
                  </>
                )}

                {/* 房主随时可解散房间 */}
                <button
                  onClick={() => { if (confirm('确定要解散房间吗？房间将被彻底删除，所有观众将被请出。')) leaveRoom(); }}
                  className="btn btn-danger"
                >
                  ❌ 解散房间
                </button>
              </div>
            )}
          </div>

          {/* 右侧：聊天（弹幕） */}
          <div className="sidebar">
            <div className="chat-panel card">
              <h3>💬 发送弹幕 ({members.length} 人在房间)</h3>
              <div className="chat-input-area">
                <input
                  type="text"
                  className="input chat-input"
                  value={chatInput}
                  maxLength={CHAT_MAX_LENGTH}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder={`发送弹幕（最多 ${CHAT_MAX_LENGTH} 字）...`}
                />
                <button
                  onClick={sendMessage}
                  className="btn btn-primary btn-sm"
                  disabled={chatCooldown > 0 || !chatInput.trim()}
                >
                  {chatCooldown > 0 ? `${chatCooldown}s` : '发送'}
                </button>
                <button
                  onClick={() => setShowDanmakuSettings(v => !v)}
                  className="btn btn-secondary btn-sm danmaku-settings-toggle"
                  title="弹幕设置"
                >
                  ⚙️
                </button>
              </div>
              <div className="chat-rules">每 {CHAT_COOLDOWN_SEC} 秒可发送一条，每条最多 {CHAT_MAX_LENGTH} 字</div>

              {/* 弹幕设置面板（房间内，点击 ⚙️ 展开） */}
              {showDanmakuSettings && (
                <div className="danmaku-settings">
                  <label className="danmaku-setting-row">
                    <span>不透明度</span>
                    <input
                      type="range"
                      min="0.2"
                      max="1"
                      step="0.05"
                      value={danmakuOpacity}
                      onChange={(e) => setDanmakuOpacity(Number(e.target.value))}
                    />
                  </label>
                  <label className="danmaku-setting-row">
                    <span>滚动速度</span>
                    <input
                      type="range"
                      min="1"
                      max="5"
                      step="1"
                      value={danmakuSpeed}
                      onChange={(e) => setDanmakuSpeed(Number(e.target.value))}
                    />
                  </label>
                  <div className="danmaku-setting-row">
                    <span>颜色</span>
                    <div className="danmaku-colors">
                      {[
                        { c: '#ff4d4f', n: '红' },
                        { c: '#fadb14', n: '黄' },
                        { c: '#1677ff', n: '蓝' },
                        { c: '#52c41a', n: '绿' }
                      ].map(o => (
                        <button
                          key={o.c}
                          className={`danmaku-color ${danmakuColor === o.c ? 'active' : ''}`}
                          style={{ backgroundColor: o.c }}
                          title={o.n}
                          onClick={() => setDanmakuColor(o.c)}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {!isHost && (
              <button onClick={leaveRoom} className="btn btn-secondary btn-block">
                离开房间
              </button>
            )}
          </div>

          {/* 电影播放完毕：询问房主是否解散房间 */}
          {isHost && endedPrompt && (
            <div className="modal-mask">
              <div className="modal-card card">
                <h3>🎬 电影播放完毕</h3>
                <p>是否解散该房间？</p>
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => setEndedPrompt(false)}>
                    否（保留房间）
                  </button>
                  <button className="btn btn-danger" onClick={leaveRoom}>
                    是（解散房间）
                  </button>
                </div>
                <p className="chat-rules" style={{ marginTop: 10 }}>
                  保留的房间可随时进入开始新电影，或使用「❌ 解散房间」按钮解散。
                </p>
              </div>
            </div>
          )}

          {/* 直链获取：输入原视频网址 */}
          {showSniffInput && (
            <div className="modal-mask" onClick={closeSniffInput}>
              <div className="modal-card card" onClick={(e) => e.stopPropagation()}>
                <h3>🔗 直链获取</h3>
                <p className="chat-rules" style={{ marginTop: 4 }}>
                  输入视频页面网址，自动嗅探其中的 .m3u8 / mp4 / webm 直链。
                </p>
                <div className="form-group" style={{ marginTop: 12 }}>
                  <label className="label">原视频网址</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="https://example.com/video..."
                    value={sniffInput}
                    onChange={(e) => setSniffInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && generateDirectUrl()}
                  />
                </div>
                {sniffError && (
                  <div className="message error" style={{ marginTop: 10 }}>{sniffError}</div>
                )}
                <div className="modal-actions" style={{ marginTop: 16 }}>
                  <button className="btn btn-secondary" onClick={closeSniffInput} disabled={sniffLoading}>
                    取消
                  </button>
                  <button className="btn btn-primary" onClick={generateDirectUrl} disabled={sniffLoading}>
                    {sniffLoading ? '生成中...' : '生成直链'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 直链获取：捕获结果 */}
          {showSniffResult && (
            <div className="modal-mask" onClick={closeSniffResult}>
              <div className="modal-card card" onClick={(e) => e.stopPropagation()}>
                <h3>🎯 捕获到的直链</h3>
                {sniffTitle && <p className="sniff-title">{sniffTitle}</p>}
                {sniffUrls.length === 0 ? (
                  <p className="empty-text" style={{ margin: '16px 0' }}>
                    未捕获到任何视频直链。该页面可能使用了动态/加密加载，或直链不在源码中。
                  </p>
                ) : (
                  <div className="sniff-result-list">
                    {sniffUrls.map((u, idx) => (
                      <div className="sniff-result-item" key={u}>
                        <span className="sniff-index">{idx + 1}.</span>
                        <span className="sniff-url" title={u}>{u}</span>
                        <button
                          className={`btn btn-sm ${copiedUrl === u ? 'btn-success' : 'btn-primary'}`}
                          onClick={() => copySniffUrl(u)}
                        >
                          {copiedUrl === u ? '✅ 已复制' : '复制'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="modal-actions" style={{ marginTop: 16 }}>
                  <button className="btn btn-secondary" onClick={closeSniffResult}>关闭</button>
                </div>
              </div>
            </div>
          )}

          {/* 静音 / 踢出 操作菜单：固定定位在顶层，避免被头像栏裁剪 */}
          {menuUserId && menuRect && (
            <div className="menu-backdrop" onClick={() => { setMenuUserId(null); setMenuRect(null); }} />
          )}
          {menuUserId && menuRect && (() => {
            const m = members.find(mm => mm.userId === menuUserId);
            if (!m) return null;
            const isMemberHost = m.userId === room?.hostId;
            const mutedNow = mutedUserIds.has(m.userId);
            return (
              <div className="avatar-menu-fixed" style={{ left: menuRect.x, top: menuRect.y }}>
                <button onClick={() => { toggleMuteUser(m.userId); setMenuUserId(null); setMenuRect(null); }}>
                  {mutedNow ? '🔊 取消静音' : '🔇 静音此人'}
                </button>
                {isHost && !isMemberHost && (
                  <button className="danger" onClick={() => requestKick(m.userId)}>
                    🚪 踢出房间
                  </button>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
