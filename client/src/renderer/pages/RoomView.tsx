import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, useAuthStore } from '../store/authStore';
import { getAbsoluteApiBase, toProxiedUrl } from '../store/apiBase';
import { getOrCreateHostSession, getHostSession, destroyHostSession, HostSession } from '../store/hostStreaming';
import { io, Socket } from 'socket.io-client';
import Hls from 'hls.js';
import './RoomView.css';

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

interface KickVoteRequest {
  targetUserId: string;
  targetName: string;
  needed: number;
  total: number;
}

interface PlaybackVoteRequest {
  action: 'pause' | 'stop';
  initiator: string;
  needed: number;
  total: number;
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

// 语音音量 → 颜色：低音量绿色，高音量红色（绿→黄→红）
function speakingColor(level: number): string {
  const hue = 120 - Math.max(0, Math.min(1, level)) * 120; // 120(绿) → 0(红)
  return `hsl(${Math.round(hue)}, 75%, 50%)`;
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
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  const [selectedFile, setSelectedFile] = useState<any>(null);
  const [needClickPlay, setNeedClickPlay] = useState(false);
  // 假暂停抑制窗口：房主切页回来时，挂载 effect 把 session.video 从 body 移回容器，
  // HTML 规范下媒体元素在 DOM 中移动会触发一次 pause 事件。这个窗口用于忽略该「假暂停」，
  // 避免误判为「房主主动暂停」而向观众广播 host-pause。
  const suppressPauseRef = useRef(0);

  // ===== 全屏观看 + 聊天公屏 =====
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 全屏时是否打开聊天公屏
  const [showOverlayChat, setShowOverlayChat] = useState(false);
  // 聊天公屏不透明度（0.3 ~ 0.95）
  const [chatOpacity, setChatOpacity] = useState(0.72);

  // 成员 / 语音 / 聊天
  const [members, setMembers] = useState<RoomMemberInfo[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [inVoice, setInVoice] = useState(false);
  const [voiceUserIds, setVoiceUserIds] = useState<Set<string>>(new Set());
  const [speakingUserIds, setSpeakingUserIds] = useState<Set<string>>(new Set());
  const [mutedUserIds, setMutedUserIds] = useState<Set<string>>(new Set());
  const [micOn, setMicOn] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatCooldown, setChatCooldown] = useState(0);
  const [avatarBubbles, setAvatarBubbles] = useState<Record<string, string>>({});
  const [menuUserId, setMenuUserId] = useState<string | null>(null);
  const [menuRect, setMenuRect] = useState<{ x: number; y: number } | null>(null);

  // 踢出投票（观众收到的确认弹窗）
  const [kickVote, setKickVote] = useState<KickVoteRequest | null>(null);

  // 放映投票（房主发起暂停/结束 → 观众收到确认弹窗）
  const [playbackVote, setPlaybackVote] = useState<PlaybackVoteRequest | null>(null);
  // 房主自己发起的放映投票（等待其他观众同意期间显示「投票中」）
  const [pendingPlaybackAction, setPendingPlaybackAction] = useState<'pause' | 'stop' | null>(null);

  // 语音音量等级（0~1），用于头像按音量着色
  const [levelByUser, setLevelByUser] = useState<Record<string, number>>({});

  // 分辨率同步（房主视频分辨率徽标）
  const [resolution, setResolution] = useState<string | null>(null);

  // 网络视频播放模式（房主粘贴直链，观众各自加载，不经过房主带宽）
  const [usingRemoteUrl, setUsingRemoteUrl] = useState(false);
  // usingRemoteUrl 的同步镜像：addLocalTracksTo 在 room-joined 异步回调里被调用，
  // 闭包捕获的 state 可能滞后，需用 ref 保证判断准确。
  const usingRemoteUrlRef = useRef(false);
  const [remotePlayUrl, setRemotePlayUrl] = useState('');
  const [urlInput, setUrlInput] = useState('');
  // 视频加载错误提示：网络直链可能因跨域/失效而失败，需要明确反馈而非"点了没反应"
  const [videoError, setVideoError] = useState('');

  // ===== 房主本地静音（不影响观众）=====
  // 原理：视频元素音频经 WebAudio 分流为两路——
  //   监听路（经过增益节点）→ 房主扬声器，可本地静音；
  //   采集路（不经过增益节点）→ 发给观众的音频流，房主静音不影响。
  const [hostMuted, setHostMuted] = useState(false);
  const hostMutedRef = useRef(false);
  const hostAudioCtxRef = useRef<AudioContext | null>(null);
  const hostMonitorGainRef = useRef<GainNode | null>(null);
  const hostCaptureAudioTrackRef = useRef<MediaStreamTrack | null>(null);

  // 电影播放完毕：房主弹窗「是否解散该房间」
  const [endedPrompt, setEndedPrompt] = useState(false);

  const hlsRef = useRef<any>(null);
  const setupDoneRef = useRef(false);
  const recentMsgSigRef = useRef<Set<string>>(new Set());
  // 本地视频的 ObjectURL，用于切换/离开房间时 revoke，避免 Blob 泄漏
  const localObjectUrlRef = useRef<string | null>(null);
  // 进度同步节流：记录上次广播时间戳
  const lastSyncProgressRef = useRef(0);
  // 房主推流会话（模块级单例）：房主切页时推流资源跨页面存活
  const hostSessionRef = useRef<HostSession | null>(null);

  const localMicRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const speakingRef = useRef(false);
  const bubbleTimersRef = useRef<Record<string, any>>({});
  const cooldownTimerRef = useRef<any>(null);

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
        socketRef.current.disconnect();
      }
      socketRef.current = null;
    }
    // 关键修复：必须复位 setupDoneRef。
    // 否则 React Router 在 /room/A → /room/B 时复用同一组件实例，
    // setupWebSocket() 会命中 if (setupDoneRef.current) return 而直接早退，
    // 导致切换房间后聊天/语音/视频/投票全部永久失效（直到刷新页面）。
    setupDoneRef.current = false;

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
        // 解绑组件级事件：房主切页后这些 UI 事件不再需要，回到房间时重新绑定
        localEl.onloadedmetadata = null;
        localEl.onended = null;
        localEl.onerror = null;
        localEl.ontimeupdate = null;
        localEl.onpause = null;
        localEl.onplay = null;
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
    Object.values(bubbleTimersRef.current).forEach(t => clearTimeout(t));
    bubbleTimersRef.current = {};
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);

    // 释放 ObjectURL，避免 Blob 泄漏（房主切页时不释放，视频仍要用）
    if (localObjectUrlRef.current) {
      if (!hasHostSession) {
        URL.revokeObjectURL(localObjectUrlRef.current);
        localObjectUrlRef.current = null;
      }
    }

    // 重置房间相关状态，避免上一个房间的聊天与 UI 状态串到新房间
    setMessages([]);
    setLevelByUser({});
    setMutedUserIds(new Set());
    setSpeakingUserIds(new Set());
    setVoiceUserIds(new Set());
    setOnlineUserIds(new Set());
    setResolution(null);
    setUsingRemoteUrl(false);
    usingRemoteUrlRef.current = false;
    setRemotePlayUrl('');
    setVideoError('');
    setIsPlaying(false);
    isPlayingRef.current = false;
    setEndedPrompt(false);
    // 重置本地静音状态（音频图与元素复用，仅复位增益与状态）
    setHostMuted(false);
    hostMutedRef.current = false;
    if (hostMonitorGainRef.current) {
      try { hostMonitorGainRef.current.gain.value = 1; } catch {}
      hostMonitorGainRef.current = null;
    }
    hostCaptureAudioTrackRef.current = null;
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
      // 房主回到房间（或首次进入）时，清掉旧组件残留的监听器，避免叠加
      socket.removeAllListeners();
      // 触发重渲染，让挂载 effect 把 session.video 挂进展示容器（否则房主看不到画面）
      setHostSessionReady(true);
      // 关键修复：socket 是模块级单例，房主切页后再回来时它已经处于 connected 状态，
      // 不会再触发 'connect' 事件，导致 join-room 永不重新 emit、服务端不下发 room-joined，
      // 房主回来后 isPlaying 停在 false，UI 显示「请选择视频文件并开始放映」——看起来就像视频自动结束了。
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
        const code = (v.error && v.error.code) || 0;
        let msg = '视频加载失败，请检查文件格式或网络链接是否有效';
        if (code === MediaError.MEDIA_ERR_NETWORK) msg = '网络错误：直链不可达或已被服务器拒绝（防盗链/失效/跨域）';
        else if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) msg = '格式不支持：该直链无法播放，或 HLS 流未被正确识别';
        setVideoError(`${msg}。多数站点直链有时效，请重试或更换链接。`);
        setNeedClickPlay(true);
      };
      v.ontimeupdate = () => {
        const el = v;
        if (!el || !socketRef.current) return;
        const now = Date.now();
        if (now - lastSyncProgressRef.current < 2000) return;
        lastSyncProgressRef.current = now;
        socketRef.current.emit('sync-progress', {
          roomId: id,
          currentTime: el.currentTime,
          duration: el.duration || 0
        });
      };
      // 房主用原生控制条暂停/继续时，广播给观众同步（移除自定义按钮后由这里兜底）
      v.onpause = () => {
        // 忽略「假暂停」：切页回来时 DOM 移动触发的 pause（抑制窗口内），不应广播。
        if (Date.now() - suppressPauseRef.current < 800) return;
        // 仅当正在放映中才广播，避免切页隐藏/加载时误触发。
        // 用 isPlayingRef（同步镜像）而非闭包捕获的 isPlaying state（会是旧值 false，导致广播发不出）。
        if (isPlayingRef.current && socketRef.current) {
          socketRef.current.emit('host-pause', { roomId: id });
        }
      };
      v.onplay = () => {
        if (Date.now() - suppressPauseRef.current < 800) return;
        if (isPlayingRef.current && socketRef.current) {
          socketRef.current.emit('host-resume', { roomId: id });
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

    socket.on('room-joined', async (data: any) => {
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
          if (u.userId && !next.some(m => m.userId === u.userId)) {
            next.push({ userId: u.userId, nickname: u.nickname || u.username, socketId: u.socketId });
          }
        });
        return next;
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
              // 本地文件模式：session.video 的 src 仍在（切页未 revoke），只需恢复播放
              usingRemoteUrlRef.current = false;
              setUsingRemoteUrl(false);
              setRemotePlayUrl('');
              if (lv.src || lv.currentSrc) {
                lv.play().catch(() => setNeedClickPlay(true));
              }
            }
          }
        } else if (ps.videoUrl) {
          // 观众 + 网络视频模式：加载直链，并在媒体可播放后追进度
          setRemotePlayUrl(ps.videoUrl);
          loadRemoteVideo(ps.videoUrl, !!ps.isHls);
          // 等待媒体就绪后跳转到房主当前进度
          const seekToProgress = () => {
            const el = remoteVideoRef.current;
            if (!el) return;
            const target = typeof ps.currentTime === 'number' ? ps.currentTime : 0;
            const applySeek = () => {
              if (el.readyState >= 1 && target > 0) {
                try { el.currentTime = target; } catch {}
              }
              el.play().catch(() => {});
            };
            if (el.readyState >= 1) applySeek();
            else el.addEventListener('loadedmetadata', applySeek, { once: true });
          };
          setTimeout(seekToProgress, 300);
        } else {
          // 观众 + 本地文件 WebRTC 模式：房主转发的流会自动续播，无需手动追进度
          setRemotePlayUrl('');
          destroyHls();
          remoteVideoRef.current?.play().catch(() => {});
        }
      }
    });

    socket.on('user-joined', (data: any) => {
      if (data.userId) {
        setOnlineUserIds(prev => new Set(prev).add(data.userId));
        setMembers(prev => {
          if (prev.some(m => m.userId === data.userId)) return prev;
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

    socket.on('offer', async (data: any) => {
      const pc = await createPeerConnection(data.from);
      const polite = isPolite(data.from);
      const makingOffer = makingOfferRef.current.get(data.from) || false;
      const offerCollision = makingOffer || pc.signalingState !== 'stable';
      const ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return;

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await pc.setLocalDescription();
        socket.emit('answer', { target: data.from, answer: pc.localDescription });
      } catch (err) {
        console.error('处理 offer 失败:', err);
      }
    });

    socket.on('answer', async (data: any) => {
      const pc = peersRef.current.get(data.from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (err) {
        console.error('处理 answer 失败:', err);
      }
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
      setPendingPlaybackAction(null);
      setResolution(data?.resolution || null);
      if (data?.videoUrl) {
        // 网络视频模式：观众各自加载直链，不经过房主带宽
        setRemotePlayUrl(data.videoUrl);
        loadRemoteVideo(data.videoUrl, !!data.isHls);
      } else {
        setRemotePlayUrl('');
        destroyHls();
        remoteVideoRef.current?.play().catch(() => {});
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
      remoteVideoRef.current?.play().catch(() => {});
      localVideoRef.current?.play().catch(() => {});
    });

    socket.on('playback-stop', () => {
      setIsPlaying(false);
      isPlayingRef.current = false;
      setPendingPlaybackAction(null);
      remoteVideoRef.current?.pause();
      localVideoRef.current?.pause();
    });

    // 房主发起「暂停/结束放映」投票 → 观众收到确认弹窗
    socket.on('playback-vote-request', (data: any) => {
      setPlaybackVote({ action: data.action, initiator: data.initiator, needed: data.needed, total: data.total });
    });

    // 进度同步（本地 mesh 模式由 WebRTC 自带；网络视频模式按此对齐播放位置）
    socket.on('progress-sync', (data: any) => {
      const el = remoteVideoRef.current;
      const t = typeof data?.currentTime === 'number' ? data.currentTime : 0;
      if (el && Math.abs(el.currentTime - t) > 2) {
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

    // 房主发起踢出 → 观众收到确认弹窗
    socket.on('kick-vote-request', (data: KickVoteRequest) => {
      // 目标本人不弹窗
      if (data.targetUserId === useAuthStore.getState().user?.id) return;
      setKickVote(data);
    });

    // 踢出结果
    socket.on('kick-vote-result', (data: any) => {
      setKickVote(null);
      if (data.kicked) {
        setMembers(prev => prev.filter(m => m.userId !== data.targetUserId));
        setOnlineUserIds(prev => {
          const next = new Set(prev);
          next.delete(data.targetUserId);
          return next;
        });
        appendSystemMessage(`🚨 「${data.targetName}」已被投票踢出房间（同意 ${data.agrees}/${data.total}），本场电影无法再次进入`);
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

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', {
          target: targetSocketId,
          candidate: event.candidate
        });
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current.set(targetSocketId, true);
        await pc.setLocalDescription();
        socketRef.current?.emit('offer', {
          target: targetSocketId,
          offer: pc.localDescription
        });
      } catch (err) {
        console.error('协商失败:', err);
      } finally {
        makingOfferRef.current.set(targetSocketId, false);
      }
    };

    pc.ontrack = (event) => {
      handleRemoteTrack(targetSocketId, event.track);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        removePeer(targetSocketId);
      }
    };

    addLocalTracksTo(pc);

    return pc;
  };

  const addLocalTracksTo = (pc: RTCPeerConnection) => {
    if (localMicRef.current) {
      localMicRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localMicRef.current!);
      });
    }
    // 网络视频模式下，视频由每位观众各自加载直链，房主不通过 WebRTC 转发视频轨。
    // 关键修复：
    //   1) isHost / usingRemoteUrl 均为 state，此处经 room-joined 异步回调调用会捕获旧值，
    //      改用 isHostRef / usingRemoteUrlRef（同步镜像）。
    //   2) localVideoRef 依赖挂载 effect 赋值，房主刚进房时可能还是 null，
    //      改用 hostSessionRef.current?.video（模块级单例，创建即可用），
    //      否则房主的视频轨道从未加到 PC，导致「本地文件观众无法观看」。
    const hostVideo = hostSessionRef.current?.video;
    if (isHostRef.current && !usingRemoteUrlRef.current && hostVideo) {
      const stream = getVideoCaptureStream();
      if (stream) {
        // 视频：来自 captureStream；音频：优先用 WebAudio 分流轨道（房主本地静音不影响观众）
        stream.getVideoTracks().forEach(track => pc.addTrack(track, stream));
        const audioTrack = hostCaptureAudioTrackRef.current;
        if (audioTrack) {
          try { pc.addTrack(audioTrack, stream); } catch {}
        } else {
          stream.getAudioTracks().forEach(track => pc.addTrack(track, stream));
        }
      }
    }
  };

  const getVideoCaptureStream = (): MediaStream | null => {
    // 优先用模块级单例 session.video（房主刚进房/切页回来时 localVideoRef 可能尚未赋值）
    const video = (hostSessionRef.current?.video || localVideoRef.current) as any;
    if (!video) return null;
    const capture = video.captureStream || video.mozCaptureStream;
    if (!capture) return null;
    const stream: MediaStream = capture.call(video);
    return stream.getTracks().length > 0 ? stream : null;
  };

  /**
   * 房主音频分流：把视频元素音频接入 WebAudio，拆成「本地监听」与「观众采集」两路。
   * 房主静音只把监听路增益置 0，观众采集路不受影响。
   * 注意：同一个媒体元素只能 createMediaElementSource 一次，源节点挂在元素属性上复用。
   */
  const setupHostAudioGraph = () => {
    const el = (hostSessionRef.current?.video || localVideoRef.current) as any;
    if (!el) return;
    try {
      if (!hostAudioCtxRef.current) {
        hostAudioCtxRef.current = new AudioContext();
      }
      const ctx = hostAudioCtxRef.current;
      ctx.resume?.().catch(() => {});

      let source: MediaElementAudioSourceNode | undefined = el.__mrAudioSource;
      if (!source) {
        source = ctx.createMediaElementSource(el);
        el.__mrAudioSource = source;

        // 监听路：房主扬声器（可本地静音）
        const monitorGain = ctx.createGain();
        source.connect(monitorGain);
        monitorGain.connect(ctx.destination);
        hostMonitorGainRef.current = monitorGain;
        monitorGain.gain.value = hostMutedRef.current ? 0 : 1;

        // 采集路：发给观众（不经过监听增益，房主静音不影响观众）
        const dest = ctx.createMediaStreamDestination();
        source.connect(dest);
        hostCaptureAudioTrackRef.current = dest.stream.getAudioTracks()[0] || null;
      } else {
        ctx.resume?.().catch(() => {});
        if (hostMonitorGainRef.current) {
          hostMonitorGainRef.current.gain.value = hostMutedRef.current ? 0 : 1;
        }
      }
    } catch (err) {
      // WebAudio 不可用时静默回退：音频仍走 captureStream 原路径，本地静音功能降级
      console.error('初始化房主音频分流失败:', err);
    }
  };

  /** 房主本地静音开关：只影响自己的扬声器，不影响观众听到的音频 */
  const toggleHostMute = () => {
    const next = !hostMuted;
    setHostMuted(next);
    hostMutedRef.current = next;
    if (hostMonitorGainRef.current) {
      try { hostMonitorGainRef.current.gain.value = next ? 0 : 1; } catch {}
    }
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
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        // 观众完全被动：播放失败不做任何兜底（不弹窗/不静音/不加按钮），浏览器自动播放策略由观众本地决定。
        remoteVideoRef.current.play().catch(() => {});
      }
    } else if (track.kind === 'audio') {
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
    remoteStreamsRef.current.delete(socketId);
    const audioEl = audioElsRef.current.get(socketId);
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioElsRef.current.delete(socketId);
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
        if (sender.track?.kind === 'audio') {
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
        const speaking = micOn && avg > 12;
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

  // ===== 踢出（房主发起，观众投票确认） =====

  const requestKick = (targetUserId: string) => {
    setMenuUserId(null);
    if (!socketRef.current) return;
    const target = members.find(m => m.userId === targetUserId);
    if (!target) return;
    if (!confirm(`确定要发起踢出「${target.nickname}」吗？\n房间内 1/3 的人同意后，TA 将被踢出且本场电影无法再次进入。`)) return;
    socketRef.current.emit('kick-request', { roomId: id, targetUserId });
    appendSystemMessage(`🗳️ 你已发起踢出「${target.nickname}」的投票，等待其他观众确认...`);
  };

  const answerKickVote = (agree: boolean) => {
    if (!kickVote || !socketRef.current) return;
    socketRef.current.emit('kick-vote', {
      roomId: id,
      targetUserId: kickVote.targetUserId,
      agree
    });
    setKickVote(null);
  };

  // ===== 聊天 =====

  const appendMessage = (msg: ChatMessage) => {
    // 去重：同用户同内容同时间戳在短时间内视为重复（防止监听器叠加导致重复消息）
    const sig = `${msg.userId}|${msg.message}|${msg.timestamp}`;
    if (msg.userId && recentMsgSigRef.current.has(sig)) return;
    if (msg.userId) {
      recentMsgSigRef.current.add(sig);
      setTimeout(() => recentMsgSigRef.current.delete(sig), 1500);
    }
    setMessages(prev => [...prev, msg]);
    if (msg.userId) {
      showAvatarBubble(msg.userId, msg.message);
    }
  };

  const appendSystemMessage = (text: string) => {
    setMessages(prev => [...prev, {
      from: '系统',
      userId: '',
      message: text,
      timestamp: new Date().toISOString()
    }]);
  };

  const showAvatarBubble = (userId: string, text: string) => {
    setAvatarBubbles(prev => ({ ...prev, [userId]: text }));
    if (bubbleTimersRef.current[userId]) {
      clearTimeout(bubbleTimersRef.current[userId]);
    }
    bubbleTimersRef.current[userId] = setTimeout(() => {
      setAvatarBubbles(prev => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    }, 6000);
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

  // ===== 房主：视频播放 =====

  const selectVideoFile = async () => {
    if ((window as any).electronAPI?.selectVideoFile) {
      const file = await (window as any).electronAPI.selectVideoFile();
      if (file) {
        // 让主进程用 pathToFileURL 生成正确的 file:// URL：
        // 直接拼接 `file://${path}` 在含空格/中文/特殊字符时会失效或被截断
        let src = `file://${file.path}`;
        try {
          const converted = await (window as any).electronAPI.getVideoUrl?.(file.path);
          if (converted) src = converted;
        } catch {
          /* 回退到拼接方式 */
        }
        loadVideoFile(src, file.name, false);
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // createObjectURL 必须配对 revokeObjectURL，否则 Blob 会一直驻留内存
      const url = URL.createObjectURL(file);
      loadVideoFile(url, file.name, true);
    }
    // 重置 value，保证连续选择同一文件也能触发 change 事件
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /** ownObjectUrl=true 表示 src 是 createObjectURL 产生的，换片/清理时需要 revoke */
  const loadVideoFile = (src: string, name: string, ownObjectUrl = false) => {
    // 先释放上一个 ObjectURL
    if (localObjectUrlRef.current) {
      URL.revokeObjectURL(localObjectUrlRef.current);
      localObjectUrlRef.current = null;
    }
    if (ownObjectUrl) {
      localObjectUrlRef.current = src;
    }
    setSelectedFile({ name });
    const el = hostSessionRef.current?.video || localVideoRef.current;
    if (el) {
      el.src = src;
      el.load();
    }
  };

  // ===== 网络视频（HLS / 直链）加载 =====
  const destroyHls = () => {
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch {}
      hlsRef.current = null;
    }
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
    // 去参数、去 hash 后的路径
    let pathPart = '';
    try {
      const u = new URL(url);
      pathPart = `${u.pathname}${u.search}`;
    } catch {
      pathPart = url;
    }
    return /(\.m3u8|m3u8|hls|\.ts)(\?|&|#|$)/i.test(pathPart);
  }

  /**
   * 用 hls.js 加载 HLS 流。
   * 关键点：必须在 manifest 解析完成（MANIFEST_PARSED）之后才调用 play()，
   * 否则在 attachMedia 之后立即 play() 会因媒体尚未就绪而静默失败。
   */
  const attachHls = (el: HTMLVideoElement, url: string, seekTo?: number) => {
    const hls = new Hls();
    hlsRef.current = hls;
    hls.loadSource(url);
    hls.attachMedia(el);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setVideoError('');
      // 房主切页回来重载直链时，追回原进度后再播放，避免从 0 重新播
      if (typeof seekTo === 'number' && seekTo > 0) {
        try { el.currentTime = seekTo; } catch {}
      }
      // 观众端播放失败静默忽略（不弹窗/不静音）；房主端保留点击播放兜底。
      if (el === remoteVideoRef.current) {
        el.play().catch(() => {});
      } else {
        el.play().catch(() => setNeedClickPlay(true));
      }
    });
    hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
      if (!data?.fatal) return;
      console.error('HLS 播放错误：', data);
      // 网络错误时可尝试一次自动恢复，避免临时抖动直接判死
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }
      setVideoError('视频加载失败：HLS 流解析出错。请确认直链有效且未过期（多数站点直链有时效），重试或更换链接。');
      // 观众端不显示点击播放按钮
      if (el !== remoteVideoRef.current) {
        setNeedClickPlay(true);
      }
    });
  };

  const loadRemoteVideo = (url: string, isHls: boolean) => {
    const el = remoteVideoRef.current;
    if (!el) return;
    setVideoError('');
    destroyHls();
    const target = toProxiedUrl(url);
    // 增强 HLS 识别：显式标记 或 启发式判断
    const useHls = isHls || looksLikeHls(url);
    if (useHls && Hls.isSupported()) {
      attachHls(el, target);
    } else if (useHls && el.canPlayType('application/vnd.apple.mpegurl')) {
      // 原生 HLS 支持（Safari）：直接交给 <video>
      el.src = target;
      el.play().catch(() => {});
    } else {
      el.src = target;
      el.play().catch(() => {});
    }
  };

  // 房主本地也直接加载网络视频观看（不通过 WebRTC 转发）
  const loadLocalUrl = (url: string, isHls: boolean, seekTo?: number) => {
    const el = hostSessionRef.current?.video || localVideoRef.current;
    if (!el) return;
    setVideoError('');
    destroyHls();
    const target = toProxiedUrl(url);
    const useHls = isHls || looksLikeHls(url);
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
      attachHls(el, target, seekTo);
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

  const startPlayback = async () => {
    if (usingRemoteUrlRef.current) {
      const url = remotePlayUrl.trim();
      if (!url) { alert('请先粘贴要播放的网络视频地址'); return; }
      // 增强 HLS 识别：不再只认 .m3u8，覆盖无扩展名的 HLS 直链
      const isHls = looksLikeHls(url);
      setIsPlaying(true);
      isPlayingRef.current = true;
      loadLocalUrl(url, isHls);
      socketRef.current?.emit('host-start-play', {
        roomId: id,
        movieName: url,
        videoUrl: url,
        isHls,
        resolution: getResolution()
      });
      return;
    }

    if (!selectedFile) {
      alert('请先选择视频文件');
      return;
    }

    setIsPlaying(true);
    isPlayingRef.current = true;

    const hostVideo = hostSessionRef.current?.video || localVideoRef.current;
    if (hostVideo) {
      try {
        // 先建立音频分流（需要用户手势才能启动 AudioContext，此刻正好是点击事件内）
        setupHostAudioGraph();
        await hostVideo.play();
      } catch (err) {
        console.error('播放失败:', err);
        alert('视频播放失败，请检查文件格式');
        setIsPlaying(false);
        isPlayingRef.current = false;
        return;
      }
    }

    const stream = getVideoCaptureStream();
    if (stream) {
      peersRef.current.forEach(pc => {
        const existingKinds = pc.getSenders().map(s => s.track?.kind);
        // 视频：来自 captureStream；音频：优先用 WebAudio 分流轨道（房主本地静音不影响观众）
        stream.getVideoTracks().forEach(track => {
          if (!existingKinds.includes('video')) {
            try { pc.addTrack(track, stream); } catch {}
          }
        });
        const audioTrack = hostCaptureAudioTrackRef.current;
        if (audioTrack) {
          if (!existingKinds.includes('audio')) {
            try { pc.addTrack(audioTrack, stream); } catch {}
          }
        } else {
          stream.getAudioTracks().forEach(track => {
            if (!existingKinds.includes('audio')) {
              try { pc.addTrack(track, stream); } catch {}
            }
          });
        }
      });
    }

    socketRef.current?.emit('host-start-play', {
      roomId: id,
      movieName: selectedFile.name,
      resolution: getResolution()
    });
  };

  // 暂停/继续已改为房主直接操作视频原生控制条（onpause/onplay 广播 host-pause/host-resume）。
  // 结束放映仍走观众投票。

  // 结束放映（之后才能解散房间）
  const stopPlayback = () => {
    if (!socketRef.current) return;
    setPendingPlaybackAction('stop');
    socketRef.current.emit('playback-vote-request', { roomId: id, action: 'stop' });
    appendSystemMessage('🗳️ 已发起「结束放映」投票，需房间内观众同意后生效...');
  };

  const answerPlaybackVote = (agree: boolean) => {
    if (!playbackVote || !socketRef.current) return;
    socketRef.current.emit('playback-vote', { roomId: id, action: playbackVote.action, agree });
    setPlaybackVote(null);
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
            {room?.hasPassword && !isHost && <p>🔒 需要密码</p>}
          </div>

          {room?.hasPassword && !isHost && (
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
              const bubble = avatarBubbles[member.userId];

              return (
                <div key={member.userId} className="avatar-rail-item">
                  {(() => {
                    const lvl = speaking ? levelByUser[member.userId] : undefined;
                    const speakColor = lvl != null ? speakingColor(lvl) : undefined;
                    return (
                      <div
                        className={`avatar-circle ${speaking ? 'speaking' : ''} ${isMemberHost ? 'host' : ''} ${!onlineUserIds.has(member.userId) && !isMe ? 'offline' : ''}`}
                        style={speakColor ? { borderColor: speakColor, boxShadow: `0 0 12px ${speakColor}` } : undefined}
                        title={member.nickname}
                        onClick={(e) => {
                          if (isMe) return;
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setMenuRect({ x: r.right + 6, y: r.top });
                          setMenuUserId(menuUserId === member.userId ? null : member.userId);
                        }}
                      >
                        {member.nickname.charAt(0).toUpperCase()}
                        {isMemberHost && <span className="host-crown">👑</span>}
                        {muted && <span className="mute-badge">🔇</span>}
                        {inVoiceNow && !muted && <span className="voice-badge">🎤</span>}
                      </div>
                    );
                  })()}
                  <span className="avatar-name">{isMe ? '我' : member.nickname}</span>

                  {bubble && (
                    <div className="avatar-bubble">
                      {bubble.length > 40 ? bubble.slice(0, 40) + '…' : bubble}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 中间：视频区域 */}
          <div className="video-area">
            {/* 房主发起放映投票时显示的提示条 */}
            {isHost && pendingPlaybackAction && (
              <div className="vote-banner">
                <span>
                  🗳️ 正在发起「{pendingPlaybackAction === 'pause' ? '暂停放映' : '结束放映'}」投票，等待房间内观众同意...
                </span>
              </div>
            )}

            <div className="video-container" ref={videoContainerRef}>
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
                  onError={() => {
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

              {/* 全屏切换按钮（观众 + 房主均可用） */}
              <button
                className="fullscreen-btn"
                onClick={toggleFullscreen}
                title={isFullscreen ? '退出全屏' : '全屏观看'}
              >
                {isFullscreen ? '⛶ 退出全屏' : '⛶ 全屏'}
              </button>

              {/* 全屏时：左下角圆形半透明气泡，点击打开聊天公屏 */}
              {isFullscreen && (
                <button
                  className={`fullscreen-bubble ${showOverlayChat ? 'active' : ''}`}
                  onClick={() => setShowOverlayChat(v => !v)}
                  title={showOverlayChat ? '收起聊天公屏' : '打开聊天公屏'}
                >
                  💬
                </button>
              )}

              {/* 全屏聊天公屏：占屏幕 1/4，半透明，可调不透明度 */}
              {isFullscreen && showOverlayChat && (
                <div className="overlay-chat" style={{ opacity: chatOpacity }}>
                  <div className="overlay-chat-header">
                    <span className="overlay-chat-title">💬 聊天公屏 ({members.length} 人)</span>
                    <div className="overlay-chat-actions">
                      <label className="opacity-control" title="调整不透明度">
                        <span className="opacity-label">不透明度</span>
                        <input
                          type="range"
                          min="0.3"
                          max="0.95"
                          step="0.01"
                          value={chatOpacity}
                          onChange={(e) => setChatOpacity(Number(e.target.value))}
                        />
                      </label>
                      <button
                        className="overlay-chat-close"
                        onClick={() => setShowOverlayChat(false)}
                        title="收起"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div className="overlay-chat-messages">
                    {messages.map((msg, idx) => (
                      <div
                        key={idx}
                        className={`overlay-chat-msg ${msg.userId === myUserId && msg.from === '我' ? 'self' : ''} ${msg.from === '系统' ? 'system' : ''}`}
                      >
                        <span className="msg-from">{msg.from}:</span>
                        <span className="msg-text">{msg.message}</span>
                      </div>
                    ))}
                  </div>
                  <div className="overlay-chat-input">
                    <input
                      type="text"
                      className="input chat-input"
                      value={chatInput}
                      maxLength={CHAT_MAX_LENGTH}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                      placeholder={`发送消息（最多 ${CHAT_MAX_LENGTH} 字）...`}
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

              {!isPlaying && (
                <div className="video-overlay" style={{ pointerEvents: 'none' }}>
                  <p>
                    {isHost
                      ? (selectedFile || remotePlayUrl ? '⏸ 已暂停' : '请选择视频文件并开始放映')
                      : '等待房主开始播放'}
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
                  <button onClick={joinVoice} className="btn btn-primary btn-sm">
                    🎤 加入语音聊天
                  </button>
                </>
              )}
            </div>

            {/* 房主控制面板 */}
            {isHost && (
              <div className="host-controls">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,.mkv,.flv,.wmv"
                  style={{ display: 'none' }}
                  onChange={handleFileInput}
                />

                {/* 片源模式：本地文件 / 网络视频直链 */}
                <div className="source-tabs">
                  <button
                    className={`tab ${!usingRemoteUrl ? 'active' : ''}`}
                    onClick={() => { setUsingRemoteUrl(false); usingRemoteUrlRef.current = false; }}
                  >📁 本地文件</button>
                  <button
                    className={`tab ${usingRemoteUrl ? 'active' : ''}`}
                    onClick={() => { setUsingRemoteUrl(true); usingRemoteUrlRef.current = true; }}
                  >🌐 网络视频直链</button>
                </div>

                {usingRemoteUrl ? (
                  <div className="url-play-row">
                    <span className="selected-file">📽️ {remotePlayUrl ? remotePlayUrl : '尚未设置播放源'}</span>
                    <input
                      className="input"
                      type="text"
                      placeholder="粘贴视频直链（支持 .m3u8 HLS 或 mp4/webm 等）"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                    />
                    <button className="btn btn-secondary btn-sm" onClick={() => setRemotePlayUrl(urlInput.trim())}>
                      设为播放源
                    </button>
                  </div>
                ) : (
                  !selectedFile && (
                    <button onClick={selectVideoFile} className="btn btn-primary">
                      📁 选择视频文件
                    </button>
                  )
                )}

                {!isPlaying ? (
                  <button
                    onClick={startPlayback}
                    className="btn btn-success"
                    disabled={usingRemoteUrl ? !remotePlayUrl.trim() : !selectedFile}
                  >
                    ▶️ {usingRemoteUrl ? '播放网络视频' : '开始放映'}
                  </button>
                ) : (
                  <>
                    {/* 暂停/继续改用视频原生控制条，此处仅保留结束放映与本地静音 */}
                    <button
                      onClick={stopPlayback}
                      className="btn btn-secondary"
                      disabled={pendingPlaybackAction !== null}
                    >
                      {pendingPlaybackAction === 'stop' ? '🗳️ 投票中...' : '⏹️ 结束放映'}
                    </button>
                    {/* 房主本地静音：只静自己的扬声器，观众不受影响（本地文件模式） */}
                    {!usingRemoteUrl && (
                      <button onClick={toggleHostMute} className="btn btn-secondary">
                        {hostMuted ? '🔇 本地已静音' : '🔊 本地静音'}
                      </button>
                    )}
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

          {/* 右侧：聊天 */}
          <div className="sidebar">
            <div className="chat-panel card">
              <h3>💬 聊天 ({members.length} 人在房间)</h3>
              <div className="chat-messages">
                {messages.map((msg, idx) => (
                  <div key={idx} className={`chat-msg ${msg.userId === myUserId && msg.from === '我' ? 'self' : ''} ${msg.from === '系统' ? 'system' : ''}`}>
                    <span className="msg-from">{msg.from}:</span>
                    <span className="msg-text">{msg.message}</span>
                  </div>
                ))}
              </div>
              <div className="chat-input-area">
                <input
                  type="text"
                  className="input chat-input"
                  value={chatInput}
                  maxLength={CHAT_MAX_LENGTH}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder={`发送消息（最多 ${CHAT_MAX_LENGTH} 字）...`}
                />
                <button
                  onClick={sendMessage}
                  className="btn btn-primary btn-sm"
                  disabled={chatCooldown > 0 || !chatInput.trim()}
                >
                  {chatCooldown > 0 ? `${chatCooldown}s` : '发送'}
                </button>
              </div>
              <div className="chat-rules">每 {CHAT_COOLDOWN_SEC} 秒可发送一条，每条最多 {CHAT_MAX_LENGTH} 字</div>
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

          {/* 踢出确认弹窗（房主发起后观众收到） */}
          {kickVote && (
            <div className="modal-mask">
              <div className="modal-card card">
                <h3>🗳️ 踢出投票</h3>
                <p>
                  房主发起投票：是否同意踢出「<strong>{kickVote.targetName}</strong>」？<br />
                  房间内 1/3 的人同意（{kickVote.needed}/{kickVote.total} 人）即踢出，且本场电影无法再次进入。
                </p>
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => answerKickVote(false)}>
                    否（不同意）
                  </button>
                  <button className="btn btn-danger" onClick={() => answerKickVote(true)}>
                    是（同意踢出）
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 放映控制投票（房主发起暂停/结束放映后观众收到） */}
          {playbackVote && (
            <div className="modal-mask">
              <div className="modal-card card">
                <h3>🗳️ 放映控制投票</h3>
                <p>
                  「{playbackVote.initiator}」发起投票：是否同意
                  <strong>{playbackVote.action === 'pause' ? '暂停放映' : '结束本场放映'}</strong>？<br />
                  需房间内 1/3 的人同意（{playbackVote.needed}/{playbackVote.total} 人）后生效。
                </p>
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => answerPlaybackVote(false)}>
                    不同意
                  </button>
                  <button className="btn btn-primary" onClick={() => answerPlaybackVote(true)}>
                    同意
                  </button>
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
                    🗳️ 踢出房间
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
