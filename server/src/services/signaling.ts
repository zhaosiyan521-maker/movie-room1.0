import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../config/database';
import { dissolveRoom } from './roomDissolve';

// 存储房间和用户的映射
const roomUsers = new Map<string, Set<string>>(); // roomId -> Set of socketIds
const userRooms = new Map<string, string>(); // socketId -> roomId
// 房间内语音状态：socketId -> 是否已加入语音
const voiceStates = new Map<string, boolean>();
// 聊天限流：socketId -> 上次发消息时间
const lastChatTime = new Map<string, number>();
// speaking 上报限流：socketId -> 上次上报时间
const lastSpeakingAt = new Map<string, number>();
// 【需求4】被房主踢出后禁止再次进入该房间的时长：5 小时。
// room.ts 的「加入房间」校验复用同一常量，故导出，避免两处各写一份导致口径漂移。
export const KICK_BAN_DURATION_MS = 5 * 60 * 60 * 1000;

// 【需求4】房主每场电影的踢人配额：每场 2 次。
// 在换片（host-start-play）时清零；暂停/继续属于同一场，不清零。
const KICK_QUOTA_PER_MOVIE = 2;
// roomId -> userId -> 本场电影已发起的踢人次数
const kickQuotaUsed = new Map<string, Map<string, number>>();

// 房间当前播放状态缓存：新观众加入时据此立即续播，避免「等待房主开始播放」。
// roomId -> { playing, videoUrl?, isHls?, resolution?, currentTime, duration, updatedAt }
interface RoomPlaybackState {
  playing: boolean;
  videoUrl?: string | null;
  isHls?: boolean;
  resolution?: string | null;
  currentTime: number;
  duration: number;
}
const roomPlaybackStates = new Map<string, RoomPlaybackState>();

// 【需求1】播放位置落库节流：sync-progress 每 2 秒触发一次，若每次都写库会造成
// 无谓的磁盘写入。这里最多每 30 秒把当前进度写一次（拖动进度条时立即写，见 host-seek）。
const POSITION_PERSIST_INTERVAL_MS = 30_000;
const lastPositionPersistAt = new Map<string, number>();

// 房主断线宽限期：刷新页面/网络抖动时旧 socket 断开，但房主很快会重连。
// 宽限期内房主重新上线则取消解散/放映中断处理，避免「刷新页面房间就消失」。
const HOST_GRACE_MS = 20_000;
const pendingHostLeaves = new Map<string, NodeJS.Timeout>();

/**
 * 安排一个延迟的房主离开处理（解散 WAITING 房间 / 放映中断处理）。
 * 到期时若房主已重新在线（重新 join-room），则跳过处理。
 */
function scheduleHostLeave(
  roomId: string,
  io: Server,
  hostUserId: string,
  action: 'dissolve' | 'abrupt'
): void {
  if (pendingHostLeaves.has(`${roomId}:${action}`)) return; // 已有倒计时在跑
  const t = setTimeout(async () => {
    pendingHostLeaves.delete(`${roomId}:${action}`);
    try {
      const room = await prisma.room.findUnique({
        where: { id: roomId },
        select: { id: true, hostId: true, status: true }
      });
      if (!room || room.hostId !== hostUserId) return;

      // 房主已重新在线（新 socket 已 join-room），取消处理
      const hostOnline = Array.from(roomUsers.get(roomId) || []).some(sid => {
        const s = io.sockets.sockets.get(sid) as AuthenticatedSocket | undefined;
        return s?.userId === hostUserId;
      });
      if (hostOnline) return;

      if (action === 'dissolve') {
        await dissolveRoom(roomId, { io, reason: '房主已离开，房间自动解散' }).catch(() => {});
      } else if (room.status === 'PLAYING') {
        await handleHostAbruptLeave(io, roomId, hostUserId);
      }
    } catch (error) {
      console.error('Scheduled host leave error:', error);
    }
  }, HOST_GRACE_MS);
  pendingHostLeaves.set(`${roomId}:${action}`, t);
}

// io 实例引用：供 admin 路由主动断开被封禁用户的连接（避免与 index.ts 形成循环依赖）
let ioRef: Server | null = null;

export function getIO(): Server | null {
  return ioRef;
}

/** 强制断开某用户的所有在线连接（封禁时调用） */
export function disconnectUser(io: Server, userId: string, reason: string): void {
  for (const [roomId, sids] of roomUsers) {
    for (const sid of sids) {
      const s = io.sockets.sockets.get(sid) as AuthenticatedSocket | undefined;
      if (s?.userId !== userId) continue;
      s.emit('kicked', { roomId, reason });
      // 立即离开信令房间并断开，避免继续接收房间广播
      void leaveRoom(s, roomId, io);
      s.disconnect(true);
    }
  }
  // 用户可能尚未加入任何房间，仅在 socket 层断开
  for (const sid of io.sockets.sockets.keys()) {
    const s = io.sockets.sockets.get(sid) as AuthenticatedSocket | undefined;
    if (s?.userId === userId) s.disconnect(true);
  }
}

const CHAT_COOLDOWN_MS = 3000; // 每 3 秒一条
const CHAT_MAX_LENGTH = 50;    // 每条最多 50 字
const SPEAKING_MIN_INTERVAL_MS = 300; // speaking 上报最小间隔

// 生产环境关闭含用户名的调试日志（避免 PII 落盘）
const isProd = process.env.NODE_ENV === 'production';
function dbg(...args: any[]) {
  if (!isProd) console.log(...args);
}

interface AuthenticatedSocket extends Socket {
  userId?: string;
  username?: string;
  nickname?: string;
  isAdmin?: boolean;
}

export function setupSocketHandlers(io: Server) {
  ioRef = io;

  // 中间件：认证
  io.use(async (socket: any, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;

      if (!token) {
        return next(new Error('认证失败'));
      }

      const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as { userId: string; tv?: number };

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, username: true, nickname: true, banned: true, isAdmin: true, tokenVersion: true }
      });

      if (!user) {
        return next(new Error('用户不存在'));
      }

      // 封禁拦截：管理员（白名单）不受封禁制约，永远放行。
      if (user.banned && !user.isAdmin) {
        return next(new Error('你的账号已被永久封禁'));
      }

      // 令牌版本校验：改密 / 封禁后旧令牌立即失效
      if ((decoded.tv ?? 0) !== user.tokenVersion) {
        return next(new Error('令牌已失效，请重新登录'));
      }

      (socket as AuthenticatedSocket).userId = user.id;
      (socket as AuthenticatedSocket).username = user.username;
      (socket as AuthenticatedSocket).nickname = user.nickname || user.username;
      (socket as AuthenticatedSocket).isAdmin = user.isAdmin;
      next();
    } catch (error) {
      next(new Error('认证失败'));
    }
  });

  /**
   * 校验某 socket 是否确实已加入该房间。
   * 用于所有需要「房间成员身份」的事件：聊天、语音、WebRTC 信令。
   * 缺少这一步会让任意登录用户向任意房间注入事件（跨房间刷屏、伪造他人状态、
   * 场外操纵房主踢人、向他人注入 SDP/ICE 干扰其连接）。
   */
  function requireInRoom(socket: AuthenticatedSocket, roomId: unknown): roomId is string {
    if (typeof roomId !== 'string' || !roomId) return false;
    return userRooms.get(socket.id) === roomId;
  }

  /** WebRTC 信令：要求发送方与目标 socket 处于同一房间 */
  function requireSameRoomPeer(socket: AuthenticatedSocket, targetId: unknown): targetId is string {
    if (typeof targetId !== 'string' || !targetId) return false;
    const myRoom = userRooms.get(socket.id);
    if (!myRoom) return false;
    // 目标必须与我在同一信令房间
    const target = io.sockets.sockets.get(targetId);
    if (!target) return false;
    return target.rooms.has(myRoom);
  }

  // 校验某 socket 是否「确实在该房间且为房主」。杜绝非房主伪造播放控制、或向其他房间注入事件。
  async function requireHost(socket: AuthenticatedSocket, roomId: unknown): Promise<any | null> {
    if (!requireInRoom(socket, roomId)) {
      socket.emit('error', { message: '你不在该房间中' });
      return null;
    }
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true, hostId: true, name: true, status: true, maxViewers: true }
    });
    if (!room || room.hostId !== socket.userId) {
      socket.emit('error', { message: '只有房主可以执行该操作' });
      return null;
    }
    return room;
  }

  io.on('connection', (socket: AuthenticatedSocket) => {
    dbg(`用户连接: ${socket.username} (${socket.id})`);

    // 【需求4A】连接建立时立即下发一次当前生效的广播。
    // 大厅（房间列表）等页面只订阅、不加入房间，无法依赖 room-joined 携带广播；
    // 有了这一条，任何页面（含房间页）刷新后无需额外请求或轮询即可显示广播条。
    getActiveBroadcast()
      .then((b) => socket.emit('broadcast-update', b))
      .catch(() => {
        /* 广播不是关键路径，读取失败静默 */
      });

    // 加入房间
    socket.on('join-room', async (roomId: unknown) => {
      try {
        if (typeof roomId !== 'string' || !roomId) return;
        const roomIdStr = roomId;

        const member = await prisma.roomMember.findFirst({
          where: {
            roomId: roomIdStr,
            userId: socket.userId!
          }
        });

        if (!member) {
          socket.emit('error', { message: '你不在该房间中' });
          return;
        }

        // 【需求4】检查踢出记录： KICK_BAN_DURATION_MS（5 小时）内禁止再次进入。
        // 这是独立时效，与房间是否换片、是否换过电影无关（跨电影依然有效）。
        // 超过 5 小时的记录虽然仍留在库中，但视为已失效，放行进入。
        const ban = await prisma.roomBan.findUnique({
          where: { roomId_userId: { roomId: roomIdStr, userId: socket.userId! } }
        });
        if (ban) {
          const elapsed = Date.now() - new Date(ban.createdAt).getTime();
          if (elapsed < KICK_BAN_DURATION_MS) {
            const leftMin = Math.ceil((KICK_BAN_DURATION_MS - elapsed) / 60000);
            socket.emit('kicked', {
              roomId: roomIdStr,
              reason: `你已被房主踢出该房间，还需 ${leftMin} 分钟才能再次进入`
            });
            return;
          }
        }

        // 离开之前的房间
        if (userRooms.has(socket.id)) {
          const oldRoomId = userRooms.get(socket.id)!;
          if (oldRoomId !== roomIdStr) {
            await leaveRoom(socket, oldRoomId, io);
          }
        }

        // 加入新房间
        socket.join(roomIdStr);

        // 管理员隐身：管理员进入房间时不广播 user-joined、不加入在线用户名单，
        // 房间内其他用户完全看不到管理员（成员栏、在线列表、人数均不含管理员）。
        // 但管理员本人仍 socket.join 房间，能接收房间广播、能看到房间内所有用户。
        // 注意：userRooms（socket→room 映射，供 requireInRoom 权限校验）对管理员仍要设置，
        // 否则管理员无法通过聊天/语音等「须在房间内」的校验；隐身只体现在 roomUsers（成员名单）
        // 与 user-joined 广播上。
        const isAdmin = socket.isAdmin === true;

        userRooms.set(socket.id, roomIdStr);

        if (!isAdmin) {
          if (!roomUsers.has(roomIdStr)) {
            roomUsers.set(roomIdStr, new Set());
          }
          roomUsers.get(roomIdStr)!.add(socket.id);

          // 通知房间内其他用户
          socket.to(roomIdStr).emit('user-joined', {
            userId: socket.userId,
            username: socket.username,
            nickname: socket.nickname,
            socketId: socket.id
          });
        }

        // 发送当前房间内的用户列表给新加入的用户
        const usersInRoom = Array.from(roomUsers.get(roomIdStr) || [])
          .filter(id => id !== socket.id)
          .map((sid) => {
            const s = io.sockets.sockets.get(sid) as AuthenticatedSocket | undefined;
            return {
              socketId: sid,
              userId: s?.userId,
              username: s?.username,
              nickname: s?.nickname,
              inVoice: voiceStates.get(sid) || false
            };
          });

        // 若房间正在放映，把当前播放状态一并下发，让新观众立即续播而非「等待房主开始播放」。
        // 【需求1】内存未命中时回落到数据库：内存缓存会因服务重启、房主刷新页面
        // （房间瞬间无人）等原因丢失，但播放源已落库，新观众仍应拿到直链续播。
        let playbackState: RoomPlaybackState | null = roomPlaybackStates.get(roomIdStr) || null;
        if (!playbackState) {
          const dbRoom = await prisma.room.findUnique({
            where: { id: roomIdStr },
            select: {
              status: true,
              sourceUrl: true,
              sourceIsHls: true,
              sourceResolution: true,
              lastPositionMs: true
            }
          });
          // 只有「房间确实处于放映中」且「库中留有播放源」时才回落。
          // 否则会把房主已「结束放映」的房间错误地恢复成正在播放。
          if (dbRoom && dbRoom.status === 'PLAYING' && dbRoom.sourceUrl) {
            playbackState = {
              playing: true,
              videoUrl: dbRoom.sourceUrl,
              isHls: dbRoom.sourceIsHls,
              resolution: dbRoom.sourceResolution,
              currentTime: Math.max(0, (dbRoom.lastPositionMs || 0) / 1000),
              duration: 0
            };
            // 回填内存缓存，后续同一房间的加入不再重复查库
            roomPlaybackStates.set(roomIdStr, playbackState);
          }
        }

        // 【需求4A】随 room-joined 一并下发当前生效的广播：
        // 新进房用户无需额外请求或轮询即可看到广播条。
        const broadcast = await getActiveBroadcast();

        socket.emit('room-joined', {
          roomId: roomIdStr,
          users: usersInRoom,
          userCount: roomUsers.get(roomIdStr)?.size || 0,
          selfSocketId: socket.id,
          playbackState,
          broadcast
        });

        dbg(`${socket.username} 加入了房间 ${roomIdStr}`);
      } catch (error) {
        console.error('Join room error:', error);
        socket.emit('error', { message: '加入房间失败' });
      }
    });

    // WebRTC 信令：仅允许同房间互投
    socket.on('offer', (data: { target: string; offer: any }) => {
      if (!requireSameRoomPeer(socket, data?.target)) return;
      io.to(data.target).emit('offer', {
        from: socket.id,
        fromUserId: socket.userId,
        offer: data.offer
      });
    });

    socket.on('answer', (data: { target: string; answer: any }) => {
      if (!requireSameRoomPeer(socket, data?.target)) return;
      io.to(data.target).emit('answer', {
        from: socket.id,
        fromUserId: socket.userId,
        answer: data.answer
      });
    });

    socket.on('ice-candidate', (data: { target: string; candidate: any }) => {
      if (!requireSameRoomPeer(socket, data?.target)) return;
      io.to(data.target).emit('ice-candidate', {
        from: socket.id,
        candidate: data.candidate
      });
    });

    // 房主通知开始播放（需校验房主身份）
    socket.on('host-start-play', async (data: { roomId: string; movieName: string; videoUrl?: string; isHls?: boolean; resolution?: string | null }) => {
      const room = await requireHost(socket, data?.roomId);
      if (!room) return;

      // movieName 用于展示与落库。网络直链模式下房主端已改为发送推导出的可读片名，
      // 不再是整条 URL。此处只做类型校验；长度统一按 200 字符处理：
      // 广播 slice(0, 200)（下一段），落库同样 slice(0, 200)（下方 prisma.update）。
      if (typeof data.movieName !== 'string') {
        socket.emit('error', { message: '电影名称无效' });
        return;
      }

      // 若携带网络视频直链，做基础协议校验，避免把非 http(s) 的地址广播给观众
      if (data.videoUrl != null) {
        if (typeof data.videoUrl !== 'string' || !/^https?:\/\//i.test(data.videoUrl)) {
          socket.emit('error', { message: '视频地址格式无效（仅支持 http/https）' });
          return;
        }
        // 【直链-4】超过上限的直链若被静默截断，广播出去的就是一条注定失效的残缺地址，
        // 观众只会看到「视频加载失败」而根本不知道发生了什么。
        // 与其让所有观众一起失败，不如在这里明确拒绝并告诉房主。
        if (data.videoUrl.length > 8000) {
          socket.emit('error', { message: '视频直链过长（超过 8000 字符），无法同步给观众' });
          return;
        }
      }

      // 更新房间播放状态缓存，供新观众加入时续播
      roomPlaybackStates.set(room.id, {
        playing: true,
        videoUrl: typeof data.videoUrl === 'string' ? data.videoUrl : null,
        isHls: !!data.isHls,
        resolution: typeof data.resolution === 'string' ? data.resolution.slice(0, 20) : null,
        currentTime: 0,
        duration: 0
      });

      // 【需求4】换片 = 新的一场电影，房主的踢人配额在此清零。
      // 注意只在 host-start-play（真正开始一部影片）时重置；
      // playback-resume / playback-pause 属于同一场的暂停继续，不重置。
      kickQuotaUsed.delete(room.id);

      socket.to(room.id).emit('playback-start', {
        hostId: socket.userId,
        movieName: data.movieName.slice(0, 200),
        resolution: typeof data.resolution === 'string' ? data.resolution.slice(0, 20) : null,
        // 【直链-4】已在上面对超长直链做了硬性拒绝，这里不需要再截断，
        // 直接下发完整地址，保证观众拿到的一定是可用链接。
        videoUrl: typeof data.videoUrl === 'string' ? data.videoUrl : null,
        isHls: !!data.isHls
      });

      prisma.room.update({
        where: { id: room.id },
        data: {
          status: 'PLAYING',
          // 【S8】落库与广播必须同样截断到 200 字符。
          // 旧实现广播时 slice(0, 200)、落库却原样写入，与 PATCH /rooms/:id/status 的
          // 200 字符校验不一致。网络直链模式下 movieName 传的是整条 URL（可能很长），
          // 未截断会直接把超长字符串写进 currentMovie 字段并展示在房间列表上。
          currentMovie:
            typeof data.movieName === 'string' ? data.movieName.slice(0, 200) : null,
          // 【需求1】播放源落库：使直链不再只活在内存里。
          // 服务重启（内存清空）、房主刷新页面（房间瞬间无人触发缓存清理）之后，
          // 新观众加入仍能从数据库回落到这条直链并续播。
          sourceUrl: typeof data.videoUrl === 'string' ? data.videoUrl : null,
          sourceIsHls: !!data.isHls,
          sourceResolution: typeof data.resolution === 'string' ? data.resolution.slice(0, 20) : null,
          sourceUpdatedAt: new Date(),
          lastPositionMs: 0
        }
      }).catch(console.error);

      // 换片后位置从 0 开始，节流计时同步重置
      lastPositionPersistAt.set(room.id, Date.now());
    });

    // 房主恢复播放（暂停后由房主恢复，无需投票）
    socket.on('host-resume', async (data: { roomId: string }) => {
      const room = await requireHost(socket, data?.roomId);
      if (!room) return;

      const st = roomPlaybackStates.get(room.id);
      if (st) st.playing = true;

      socket.to(room.id).emit('playback-resume', {
        hostId: socket.userId
      });
    });

    // 房主直接暂停（无需投票，房主拥有暂停权限）
    socket.on('host-pause', async (data: { roomId: string }) => {
      const room = await requireHost(socket, data?.roomId);
      if (!room) return;

      const st = roomPlaybackStates.get(room.id);
      if (st) st.playing = false;

      // 只广播给观众，不回声给房主本人。否则房主自己收到 playback-pause 会把
      // 本地 isPlaying 置 false，触发全屏覆盖层挡住原生控制条，导致无法点继续播放。
      socket.to(room.id).emit('playback-pause', { byHost: true });
    });

    // 房主一键结束放映（已删除观众投票机制，结束放映由房主直接操作）
    socket.on('host-stop-play', async (data: { roomId: string }) => {
      const room = await requireHost(socket, data?.roomId);
      if (!room) return;

      // 清空播放状态缓存，房间回到等待状态
      roomPlaybackStates.delete(room.id);
      // 【需求1】房主主动「结束放映」是预期行为，此时连同数据库中的播放源一并清除，
      // 保持「结束放映 = 本场放映源作废」的语义一致（与房间解散时的清理口径相同）。
      lastPositionPersistAt.delete(room.id);

      await prisma.room.update({
        where: { id: room.id },
        data: {
          status: 'WAITING',
          sourceUrl: null,
          sourceIsHls: false,
          sourceResolution: null,
          sourceUpdatedAt: null,
          lastPositionMs: 0
        }
      }).catch(() => {});

      // 广播给观众（含房主自己，房主端也会收到 playback-stop 同步 isPlaying）
      io.to(room.id).emit('playback-stop', { byHost: true });
    });

    // 同步播放进度（仅房主可发起，避免观众恶意扰乱进度）
    socket.on('sync-progress', async (data: { roomId: string; currentTime: number; duration: number }) => {
      const room = await requireHost(socket, data?.roomId);
      if (!room) return;

      // 数值有效性校验，NaN/Infinity 会污染客户端进度条
      const currentTime = Number(data.currentTime);
      const duration = Number(data.duration);
      if (!Number.isFinite(currentTime) || !Number.isFinite(duration)) return;

      // 更新房间播放状态缓存，供新观众加入时续播、房主切页回来时追进度。
      const st = roomPlaybackStates.get(room.id);
      if (st) {
        st.currentTime = Math.max(0, currentTime);
        st.duration = Math.max(0, duration);
      }

      // 【需求1】进度落库（节流 30 秒）。sync-progress 每 2 秒一次，逐次写库没有必要；
      // 节流后即使服务重启，新观众也能续播到接近的位置，而不是从 0 开始。
      const nowMs = Date.now();
      const lastPersist = lastPositionPersistAt.get(room.id) || 0;
      if (nowMs - lastPersist >= POSITION_PERSIST_INTERVAL_MS) {
        lastPositionPersistAt.set(room.id, nowMs);
        prisma.room.update({
          where: { id: room.id },
          data: { lastPositionMs: Math.max(0, Math.round(currentTime * 1000)) }
        }).catch(() => {});
      }

      // 温和的周期纠偏：广播给在线观众，但客户端只在进度差 > 2 秒时才 seek，
      // 且带 3 秒冷却，避免像旧版那样每 2 秒无差别 seek 反复打断 HLS 缓冲导致卡顿。
      // 正常播放时房主观众播放同一 HLS、进度差 < 1 秒，几乎不触发 seek，保持流畅。
      socket.to(room.id).emit('progress-sync', {
        currentTime: Math.max(0, currentTime),
        duration: Math.max(0, duration)
      });
    });

    // 房主拖动进度条 seek 后广播，观众跟随 seek（进度差拉大的主因修复）
    socket.on('host-seek', async (data: { roomId: string; currentTime: number }) => {
      const room = await requireHost(socket, data?.roomId);
      if (!room) return;

      const currentTime = Number(data.currentTime);
      if (!Number.isFinite(currentTime)) return;

      // 更新缓存进度，供后续新观众续播 / 房主切页回来追进度
      const st = roomPlaybackStates.get(room.id);
      if (st) {
        st.currentTime = Math.max(0, currentTime);
      }

      // 【需求1】拖动进度条属于低频且有意义的操作，立即落库（并重置节流计时），
      // 避免服务重启后进度回退到上一次 30 秒节拍的位置。
      lastPositionPersistAt.set(room.id, Date.now());
      prisma.room.update({
        where: { id: room.id },
        data: { lastPositionMs: Math.max(0, Math.round(currentTime * 1000)) }
      }).catch(() => {});

      // 广播给观众（不含房主本人，房主本地已经 seek 到位）
      socket.to(room.id).emit('playback-seek', {
        currentTime: Math.max(0, currentTime)
      });
    });

    // 聊天消息（限流：每 3 秒一条，每条最多 50 字）
    socket.on('chat-message', (data: { roomId: string; message: string }) => {
      // 成员校验：防止向任意房间跨房间刷屏
      if (!requireInRoom(socket, data?.roomId)) return;

      const now = Date.now();
      const last = lastChatTime.get(socket.id) || 0;
      if (now - last < CHAT_COOLDOWN_MS) {
        socket.emit('chat-limited', {
          message: `发送太频繁了，请 ${Math.ceil((CHAT_COOLDOWN_MS - (now - last)) / 1000)} 秒后再发`,
          retryAfter: CHAT_COOLDOWN_MS - (now - last)
        });
        return;
      }

      const raw = typeof data.message === 'string' ? data.message : '';
      const text = raw.slice(0, CHAT_MAX_LENGTH).trim();
      if (!text) return;

      lastChatTime.set(socket.id, now);

      socket.to(data.roomId).emit('chat-message', {
        from: socket.nickname || socket.username,
        userId: socket.userId,
        message: text,
        timestamp: new Date().toISOString()
      });
    });

    // ===== 语音聊天 =====

    socket.on('voice-join', (roomId: unknown) => {
      // 成员校验：防止向任意房间伪造「某人加入语音」
      if (!requireInRoom(socket, roomId)) return;
      voiceStates.set(socket.id, true);
      socket.to(roomId).emit('voice-state', {
        socketId: socket.id,
        userId: socket.userId,
        nickname: socket.nickname,
        inVoice: true
      });
    });

    socket.on('voice-leave', (roomId: unknown) => {
      if (!requireInRoom(socket, roomId)) return;
      voiceStates.set(socket.id, false);
      socket.to(roomId).emit('voice-state', {
        socketId: socket.id,
        userId: socket.userId,
        nickname: socket.nickname,
        inVoice: false
      });
    });

    socket.on('speaking', (data: { roomId: string; speaking: boolean; level?: number }) => {
      // 成员校验 + 频率限制，防止高频事件放大为拒绝服务
      if (!requireInRoom(socket, data?.roomId)) return;

      const now = Date.now();
      const last = lastSpeakingAt.get(socket.id) || 0;
      if (now - last < SPEAKING_MIN_INTERVAL_MS) return;
      lastSpeakingAt.set(socket.id, now);

      const level = typeof data.level === 'number'
        ? Math.max(0, Math.min(1, data.level))
        : (data.speaking ? 1 : 0);
      socket.to(data.roomId).emit('user-speaking', {
        userId: socket.userId,
        socketId: socket.id,
        speaking: data.speaking,
        level
      });
    });

    // ===== 房主踢人（房主直接踢出，无需投票） =====

    // 房主直接踢出指定成员：立即写入 5 小时黑名单并强制其离开房间
    socket.on('kick-user', async (data: { roomId: string; targetUserId: string }) => {
      try {
        if (!requireInRoom(socket, data?.roomId)) return;
        const { roomId, targetUserId } = data;

        if (typeof targetUserId !== 'string' || !targetUserId) return;

        // 验证发起者是房主
        const room = await prisma.room.findUnique({
          where: { id: roomId },
          select: { id: true, hostId: true }
        });
        if (!room || room.hostId !== socket.userId) {
          socket.emit('error', { message: '只有房主可以踢出成员' });
          return;
        }

        if (targetUserId === socket.userId) {
          socket.emit('error', { message: '不能踢出自己' });
          return;
        }

        // 【需求4】目标不得是房主。房间归属于 hostId，房主一旦被踢出房间归属即悬空。
        // 由于发起权限仅限房主、且上面已禁止踢自己，正常流程下本分支不会命中；
        // 保留作为防御性校验，避免日后权限再次放宽时出现漏洞。
        if (room.hostId === targetUserId) {
          socket.emit('error', { message: '房主不可被踢出' });
          return;
        }

        // 【需求4】房主每场电影 2 次踢人配额，超出需等到换片才恢复
        let quotaMap = kickQuotaUsed.get(roomId);
        if (!quotaMap) {
          quotaMap = new Map<string, number>();
          kickQuotaUsed.set(roomId, quotaMap);
        }
        const used = quotaMap.get(socket.userId!) || 0;
        if (used >= KICK_QUOTA_PER_MOVIE) {
          socket.emit('error', {
            message: `本场电影的踢人次数已用完（${KICK_QUOTA_PER_MOVIE}/${KICK_QUOTA_PER_MOVIE}），换片后自动恢复`
          });
          return;
        }

        // 目标必须是房间成员，否则可对任意用户写入黑名单
        const targetMember = await prisma.roomMember.findUnique({
          where: { roomId_userId: { roomId, userId: targetUserId } }
        });
        if (!targetMember) {
          socket.emit('error', { message: '该用户不在此房间中' });
          return;
        }

        const targetUser = await prisma.user.findUnique({
          where: { id: targetUserId },
          select: { nickname: true, username: true }
        });
        if (!targetUser) return;
        const targetName = targetUser.nickname || targetUser.username;

        // 真正执行踢出，此时才扣配额（前面各种被拒的情形一律不扣）
        quotaMap.set(socket.userId!, used + 1);

        await applyKick(io, roomId, targetUserId, targetName, '房主踢出');
      } catch (error) {
        console.error('Kick user error:', error);
        socket.emit('error', { message: '踢出失败' });
      }
    });

    // 断开连接
    socket.on('disconnect', () => {
      handleDisconnect(socket, io);
    });

    // 手动离开房间
    socket.on('leave-room', (roomId: unknown) => {
      if (!requireInRoom(socket, roomId)) return;
      leaveRoom(socket, roomId, io, true);
    });
  });
}

/**
 * 执行踢出：写入 / 刷新 5 小时黑名单 → 移出房间成员 → 强制断开目标的所有连接 → 通知房间。
 * 由房主直接踢人（kick-user）调用。
 */
async function applyKick(
  io: Server,
  roomId: string,
  targetUserId: string,
  targetName: string,
  reason: string
) {
  // 【需求4】写入 / 刷新踢出记录。禁入有效期 KICK_BAN_DURATION_MS（5 小时）。
  // 关键：update 必须刷新 createdAt —— 旧实现的 update 是空的 {}，
  // 同一用户第二次被踢时 createdAt 不更新，5 小时会从上一次被踢起算，
  // 实际禁入时长远短于预期（甚至早已过期，等于完全没有惩罚）。
  await prisma.roomBan.upsert({
    where: { roomId_userId: { roomId, userId: targetUserId } },
    create: { roomId, userId: targetUserId, reason },
    update: { createdAt: new Date(), reason }
  });
  await prisma.roomMember.deleteMany({
    where: { roomId, userId: targetUserId }
  });

  // 强制目标用户的所有 socket 离开房间
  const targetSockets = Array.from(roomUsers.get(roomId) || [])
    .filter(sid => {
      const s = io.sockets.sockets.get(sid) as AuthenticatedSocket | undefined;
      return s?.userId === targetUserId;
    });

  for (const sid of targetSockets) {
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.emit('kicked', { roomId, reason: '你已被房主踢出该房间，5 小时内无法再次进入' });
      await leaveRoom(s as AuthenticatedSocket, roomId, io);
    }
  }

  io.to(roomId).emit('kick-result', {
    targetUserId,
    targetName,
    kicked: true
  });

  dbg(`用户 ${targetName} 在房间 ${roomId} 被房主踢出`);
}

async function leaveRoom(socket: AuthenticatedSocket, roomId: string, io: Server, voluntary = false) {
  socket.leave(roomId);

  // 判断是否是房主在放映途中离开/断线
  let hostAbrupt = false;
  try {
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true, hostId: true, status: true }
    });
    if (room && room.status === 'PLAYING' && room.hostId === socket.userId) {
      if (voluntary) {
        // 放映途中房主主动解散（HTTP 接口已放行房主随时解散，此处为 socket 兜底）：直接解散
        await dissolveRoom(roomId, { io }).catch(() => {});
      } else {
        // 强行关闭网页导致放映中断：进入宽限期，房主快速重连（如刷新页面）则取消
        hostAbrupt = true;
        scheduleHostLeave(roomId, io, socket.userId!, 'abrupt');
      }
    } else if (room && room.status !== 'PLAYING' && room.hostId === socket.userId) {
      if (voluntary) {
        // 房主主动退出（含放映已结束的房间）：彻底解散并清除房间，不留历史记录
        await dissolveRoom(roomId, { io }).catch(() => {});
      } else {
        // 断线（刷新页面/网络抖动）：宽限期内房主重连则取消解散
        scheduleHostLeave(roomId, io, socket.userId!, 'dissolve');
      }
    }
  } catch (error) {
    console.error('Leave room check error:', error);
  }

  if (roomUsers.has(roomId)) {
    roomUsers.get(roomId)!.delete(socket.id);
    if (roomUsers.get(roomId)!.size === 0) {
      roomUsers.delete(roomId);
      // 【需求1】此处**不再**清空播放状态缓存。
      // 旧实现在房间内人数归零时 delete，导致房主刷新页面的那一瞬间（房间只剩他一人）
      // 播放源就被丢弃，新观众加入后拿不到直链。播放源只在房主「结束放映」
      // 或房间被解散时才清除。
      lastPositionPersistAt.delete(roomId);
    }
  }

  userRooms.delete(socket.id);
  voiceStates.delete(socket.id);
  lastChatTime.delete(socket.id);
  lastSpeakingAt.delete(socket.id);

  // 通知房间内其他用户（管理员隐身，不广播 user-left，与其从未广播 user-joined 对称）
  if (!socket.isAdmin) {
    socket.to(roomId).emit('user-left', {
      userId: socket.userId,
      username: socket.username,
      nickname: socket.nickname,
      socketId: socket.id,
      hostAbrupt
    });
  }

  dbg(`${socket.username} 离开了房间 ${roomId}`);
}

/**
 * 房间解散后清理其在内存中的全部信令状态：
 * roomUsers/userRooms/播放状态缓存/语音与限流记录，以及挂起的房主宽限计时器。
 * dissolveRoom 只做了 socketsLeave（适配器层），不经过 leaveRoom，内存状态会残留，需显式清理。
 */
export function purgeRoomSignalingState(roomId: string): void {
  const sids = roomUsers.get(roomId);
  if (sids) {
    for (const sid of sids) {
      userRooms.delete(sid);
      voiceStates.delete(sid);
      lastChatTime.delete(sid);
      lastSpeakingAt.delete(sid);
    }
  }
  roomUsers.delete(roomId);
  kickQuotaUsed.delete(roomId);
  roomPlaybackStates.delete(roomId);
  lastPositionPersistAt.delete(roomId);
  for (const action of ['dissolve', 'abrupt'] as const) {
    const key = `${roomId}:${action}`;
    const t = pendingHostLeaves.get(key);
    if (t) {
      clearTimeout(t);
      pendingHostLeaves.delete(key);
    }
  }
}

// 房主放映中断线：结束本场放映、房间回到等待状态，并通知房间内观众。
// 需求变更：允许房主随意中断放映，不再累计中断次数、不再封禁账号或 IP。
async function handleHostAbruptLeave(io: Server, roomId: string, hostUserId: string) {
  try {
    // 结束本场放映，房间回到等待状态。
    // 【需求1】注意：这里**不清空数据库中的播放源**。房主只是断线（网络抖动、电脑休眠、
    // 切后台超时），房间本身并未解散，直链应当保留下来，只是内存中的「正在放映」状态
    // 被清掉（房主不在，放映确实已停止）。
    await prisma.room.update({
      where: { id: roomId },
      data: { status: 'WAITING' }
    }).catch(() => {});

    roomPlaybackStates.delete(roomId); // 放映中断，清空内存播放状态（数据库中播放源保留）
    lastPositionPersistAt.delete(roomId);

    io.to(roomId).emit('host-disconnected', {
      message: '房主连接中断，放映已结束'
    });

    dbg(`房主 ${hostUserId} 放映中断线，放映已结束`);
  } catch (error) {
    console.error('Handle host abrupt leave error:', error);
  }
}

function handleDisconnect(socket: AuthenticatedSocket, io: Server) {
  const roomId = userRooms.get(socket.id);
  if (roomId) {
    void leaveRoom(socket, roomId, io);
  }
  // 即使未加入房间也要清理该 socket 的限流状态，避免内存泄漏
  lastChatTime.delete(socket.id);
  lastSpeakingAt.delete(socket.id);
  voiceStates.delete(socket.id);
  dbg(`用户断开连接: ${socket.username} (${socket.id})`);
}

// ===== 【需求4A】广播下发 =====

export interface BroadcastPayload {
  id: string;
  content: string;
  color: string;
  speed: number;
  createdAt: Date;
}

/**
 * 读取当前生效的广播（最新发布且 active 的一条），没有则返回 null。
 * 广播沿用「弹幕」的产品语义：一条循环滚动的文字，永久有效直到管理员手动停播。
 */
export async function getActiveBroadcast(): Promise<BroadcastPayload | null> {
  try {
    return await prisma.broadcast.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, content: true, color: true, speed: true, createdAt: true }
    });
  } catch {
    return null;
  }
}

/**
 * 把最新广播实时推送给所有在线连接。
 * 由管理员发布 / 停播接口调用；客户端收到 `broadcast-update` 后立即刷新广播条，
 * 因此不需要轮询。传 null 表示当前没有广播（客户端据此隐藏）。
 */
export async function pushBroadcastUpdate(): Promise<void> {
  const io = ioRef;
  if (!io) return;
  const broadcast = await getActiveBroadcast();
  io.emit('broadcast-update', broadcast);
}
