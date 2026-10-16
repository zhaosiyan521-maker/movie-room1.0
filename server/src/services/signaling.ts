import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../config/database';
import { dissolveRoom } from './roomDissolve';
import {
  canScreen,
  canDissolve,
  isPublicRoom,
  markScreeningGrace,
  releaseScreening,
  reapScreeningHosts
} from './roomAccess';

// 存储房间和用户的映射
const roomUsers = new Map<string, Set<string>>(); // roomId -> Set of socketIds
/**
 * 【BUG-02 修复】roomId -> Set of userId（同一账号的多个标签页只算一个用户）。
 *
 * 为什么要单独维护：`roomUsers` 是 socketId 集合，同一账号开两个标签页会有两个
 * socketId。而「成员」在业务上是**用户**维度（成员行 unique(roomId,userId)、
 * 房间列表人数、满员判定都按用户算）。之前没有任何地方能回答
 * 「这个用户还有别的标签页在这个房间吗」，于是任一标签页离开就把用户整行删掉，
 * 造成人数少 1、凭空腾出名额，而另一个标签页其实还在房间里。
 */
const roomUserIds = new Map<string, Set<string>>(); // roomId -> Set of userIds
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

/** 【公共房间】放映位超时巡检定时器（进程内单例，避免重复注册） */
let screeningReaperTimer: NodeJS.Timeout | null = null;

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

/**
 * 【P2 修复】启动时回收「上次进程退出时残留」的房间成员行。
 *
 * 为什么需要：进程被强杀 / 断电 / PM2 重启时，所有 socket 的 disconnect 处理器
 * 都不会执行，内存中的在线映射随之丢失，但 room_members 行仍留在库里。
 * 这些行会永久占用房间名额（join 按行数判断满员），表现为「重启后房间显示已满、
 * 但房间里其实一个人没有」。既然进程重启后内存映射已是权威的空状态，
 * 这里可以安全地清空所有成员行，让成员行重新等于「本次进程生命周期内的真实成员」。
 *
 * 仅在启动时执行一次，且只删成员行（不动房间、用户、黑名单等其他数据）。
 */
async function reapStaleRoomMembers(): Promise<void> {
  try {
    const res = await prisma.roomMember.deleteMany({});
    if (res.count > 0) {
      dbg(`启动清理：已回收 ${res.count} 条上次运行残留的房间成员记录`);
      console.log(`🧹 启动清理：回收了 ${res.count} 条残留的房间成员记录（占用的房间名额已释放）`);
    }
  } catch (error) {
    // 清理失败不应阻断启动；但若持续失败，房间名额会被幽灵占用，需留日志
    console.error('启动清理房间成员记录失败（房间名额可能被残留记录占用）:', error);
  }
}

/**
 * 【BUG-02 修复】取出房间内「仍然真实存在」的 socketId，并顺手剔除幽灵 id。
 *
 * 为什么必须剔除：`roomUsers` 里可能残留已被销毁的 socketId（例如 socket 已断开、
 * 但某条清理路径没走到，或断开与离开并发交错）。这类 id 在
 * `io.sockets.sockets.get(sid)` 上取不到对象 —— 如果照旧用
 * `若取不到就当作 userId 不匹配` 的写法，它们会被当成「别人的 socket」永久占位，
 * 结果是**成员行再也删不掉**（实测就是这个现象：members 里混着两个已死的 id，
 * 导致判断「该用户是否还有别的标签页」恒为真）。
 *
 * 因此：取不到对象的一律视为已失效并清除；同时把「集合里还有 userId 相同的活跃 socket」
 * 与「集合里还有任何活跃 socket」一并算出来，供调用方使用。
 */
function pruneAndInspect(roomId: string, forUserId?: string) {
  const sids = roomUsers.get(roomId);
  if (!sids) return { liveUserIds: new Set<string>(), liveCount: 0 };
  const liveUserIds = new Set<string>();
  let liveCount = 0;
  for (const sid of Array.from(sids)) {
    const s = ioRef?.sockets?.sockets?.get(sid) as AuthenticatedSocket | undefined;
    if (!s) {
      sids.delete(sid); // 幽灵：socket 已不存在
      continue;
    }
    liveCount++;
    if (s.userId) liveUserIds.add(s.userId);
  }
  if (sids.size === 0) {
    roomUsers.delete(roomId);
    roomUserIds.delete(roomId);
  } else if (forUserId && !liveUserIds.has(forUserId)) {
    const ids = roomUserIds.get(roomId);
    if (ids) {
      ids.delete(forUserId);
      if (ids.size === 0) roomUserIds.delete(roomId);
    }
  }
  return { liveUserIds, liveCount };
}

/**
 * 【BUG-02 修复】把 socket 的 userId 登记到房间的用户集合。
 * 管理员隐身（不进 roomUsers），但这里**仍要登记** —— 下文
 * isLastUserSocket 需要能回答「这个用户还有没有别的 socket 在房间」。
 */
function trackUserSocket(roomId: string, userId: string | undefined): void {
  if (!userId) return;
  let ids = roomUserIds.get(roomId);
  if (!ids) {
    ids = new Set();
    roomUserIds.set(roomId, ids);
  }
  ids.add(userId);
}

/**
 * 【BUG-02 修复】移除某 socket 在房间内的登记，返回「这是否是该用户在本房间的最后一个 socket」。
 *
 * 判定依据是**活跃** socket（先剔除幽灵 id 再比较 userId），
 * 否则被销毁 socket 的残留 id 会让判定永远为「还有别人」，成员行永远删不掉。
 */
function untrackUserSocket(roomId: string, socketId: string, userId: string | undefined): boolean {
  const sids = roomUsers.get(roomId);
  if (sids) sids.delete(socketId);

  if (!userId) {
    // 管理员（隐身）不参与用户集合；退化为「房间内已无活跃 socket」
    return pruneAndInspect(roomId).liveCount === 0;
  }

  const { liveUserIds } = pruneAndInspect(roomId, userId);
  const stillThere = liveUserIds.has(userId);
  if (!stillThere) {
    const ids = roomUserIds.get(roomId);
    if (ids) {
      ids.delete(userId);
      if (ids.size === 0) roomUserIds.delete(roomId);
    }
  }
  return !stillThere;
}

/** 房间内当前的不同用户数（管理员隐身，不计入） */
export function roomDistinctUserCount(roomId: string): number {
  return roomUserIds.get(roomId)?.size || 0;
}

/**
 * 【BUG-02 修复】该用户在本房间是否还有**其他** socket 在线（多标签页）。
 *
 * 供 HTTP /leave 复用：客户端调 /leave 时它自己的 socket 通常还连着，
 * 因此不能用「集合里还有没有这个用户」来判（会恒为真），必须排除已知的 socketId。
 *
 * @param exceptSocketId 调用方自身的 socketId（未知时传 null，则任意一个在线即算）
 */
export function userHasOtherSocketInRoom(
  roomId: string,
  userId: string,
  exceptSocketId: string | null = null
): boolean {
  if (!userId) return false;
  const sids = roomUsers.get(roomId);
  if (!sids) return false;
  let found = false;
  for (const sid of Array.from(sids)) {
    const s = ioRef?.sockets?.sockets?.get(sid) as AuthenticatedSocket | undefined;
    if (!s) {
      // 幽灵 id（socket 已不存在）：清除，且绝不能算作「另一个标签页」
      sids.delete(sid);
      continue;
    }
    if (sid !== exceptSocketId && s.userId === userId) found = true;
  }
  if (sids.size === 0) {
    roomUsers.delete(roomId);
    roomUserIds.delete(roomId);
  }
  return found;
}

/** 供 HTTP /leave 复用：把指定 socket 真正移出房间（含成员行、user-left 广播、
 *  房主宽限/解散判定）。返回是否找到了该 socket。 */
export async function leaveRoomBySocketId(roomId: string, socketId: string): Promise<boolean> {
  const s = ioRef?.sockets?.sockets?.get(socketId) as AuthenticatedSocket | undefined;
  if (!s) return false;
  const io = ioRef!;
  // 手动离开（voluntary=true）：房主此时应彻底解散而非进入宽限期
  await leaveRoom(s, roomId, io, true);
  return true;
}

/** 供 HTTP /leave 复用：通知房间内其他人该用户已离开 */
export function emitUserLeftForSocket(roomId: string, socketId: string): void {
  const s = ioRef?.sockets?.sockets?.get(socketId) as AuthenticatedSocket | undefined;
  if (!s) return;
  s.to(roomId).emit('user-left', {
    userId: s.userId,
    username: s.username,
    nickname: s.nickname,
    socketId: s.id,
  });
}

/**
 * 【BUG-01 修复】判断「当前是否还有别的服务实例在跑」。
 *
 * 判定依据：service_instances 表里存在**其他**行，且其 heartbeatAt 足够新
 * （在 INSTANCE_STALE_MS 之内）。心跳由每个实例每 15 秒更新一次。
 *
 * 为什么必须落库而不是用进程内变量：这段判断发生在**进程启动时**，
 * 要回答的正是「上一次运行的实例是否还活着」——重启后进程内变量必然是空的，
 * 唯有持久化的心跳能区分「单实例重启（旧实例已死）」与「多副本并存（旧实例仍活着）」。
 */
const INSTANCE_STALE_MS = 45 * 1000; // 45s 内无心跳视为已死（心跳间隔 15s，留 3 倍余量）

async function hasOtherLiveInstance(): Promise<boolean> {
  try {
    const alive = await prisma.serviceInstance.findFirst({
      where: {
        id: { not: currentInstanceId },
        heartbeatAt: { gte: new Date(Date.now() - INSTANCE_STALE_MS) }
      },
      select: { id: true }
    });
    return !!alive;
  } catch (error) {
    // 查询失败时保守处理：按「有别的实例」对待，宁可不清成员行（残留只是占名额，
    // 而误删会把正在观影的人踢出名单）
    console.error('检查其他服务实例失败（按「存在其他实例」保守处理）:', error);
    return true;
  }
}

/** 本进程的实例 id（启动时生成一次，用于心跳表与自身排除） */
const currentInstanceId = `inst-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let instanceHeartbeatTimer: NodeJS.Timeout | null = null;

/** 注册本实例并开始心跳（幂等） */
async function registerInstance(): Promise<void> {
  try {
    await prisma.serviceInstance.upsert({
      where: { id: currentInstanceId },
      create: { id: currentInstanceId },
      update: { heartbeatAt: new Date() }
    });
    // 顺手清理早已死掉的历史实例行，避免表无限增长
    await prisma.serviceInstance.deleteMany({
      where: { heartbeatAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
    });
  } catch (error) {
    console.error('注册服务实例心跳失败（不影响主流程）:', error);
  }
}

export function setupSocketHandlers(io: Server) {
  ioRef = io;

  // 【BUG-01】先注册本实例心跳，再据此决定启动清理的范围。
  // 注册与清理必须串行：清理要用到「是否还有其他活跃实例」这一判断结果。
  void (async () => {
    await registerInstance();

    const multiInstance = await hasOtherLiveInstance();
    if (multiInstance) {
      // 多副本并存：绝不能做全表清理，否则会把其他副本上正在观影的用户删掉
      console.warn(
        '⚠️ 检测到其他活跃服务实例：跳过房间成员行的启动清理。' +
        '（多副本部署时全表清理会误删其他实例上正在观看的用户）'
      );
      console.warn(
        '⚠️ 注意：本项目的 Socket.IO 使用内存适配器、状态保存在进程内，' +
        '多副本下观众收不到跨副本的进度/语音/成员事件；数据库为 SQLite，' +
        '并发写入也存在锁冲突风险。多副本部署需先完成状态外置与数据库替换。'
      );
    } else {
      void reapStaleRoomMembers();
      void reapScreeningHosts();
    }

    if (!instanceHeartbeatTimer) {
      instanceHeartbeatTimer = setInterval(() => { void registerInstance(); }, 15 * 1000);
      instanceHeartbeatTimer.unref?.();
    }
  })();

  // 【公共房间需求】放映位巡检：每 30 秒一次，把宽限期已过的放映位释放。
  // 之所以放在这里（而不是上面那个 async 块里）：
  //   1) 巡检必须持续运行，与「启动清理是否执行」无关；
  //   2) 启动时的一次性清理已在上面的多实例判断之后执行，不要重复。
  if (!screeningReaperTimer) {
    screeningReaperTimer = setInterval(() => { void reapScreeningHosts(); }, 30 * 1000);
    // 不阻止进程退出（pm2 restart / 测试脚本结束时能正常收尾）
    screeningReaperTimer.unref?.();
  }

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

  /**
   * 校验某 socket 是否有「放映权限」（可执行开播/暂停/结束/设源等房主操作）。
   *
   * 【公共房间需求】判定从「必须是 hostId」放宽为 canScreen：
   *   - 管理员：始终通过（便于随时接管公共房间）
   *   - 真实房主：通过（普通房间行为完全不变）
   *   - 公共房间的放映人：通过（通过放映通道进入的那个人）
   * 注意：**解散房间不在这里判**，放映人没有解散权（见 canDissolve）。
   */
  async function requireHost(socket: AuthenticatedSocket, roomId: unknown): Promise<any | null> {
    if (!requireInRoom(socket, roomId)) {
      socket.emit('error', { message: '你不在该房间中' });
      return null;
    }
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true, hostId: true, name: true, status: true, maxViewers: true }
    });
    if (!room) {
      socket.emit('error', { message: '房间不存在' });
      return null;
    }
    const allowed = await canScreen(roomId, socket.userId!, socket.isAdmin === true);
    if (!allowed) {
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

        // 【需求4】先检查踢出记录：KICK_BAN_DURATION_MS（5 小时）内禁止再次进入。
        // 这是独立时效，与房间是否换片、是否换过电影无关（跨电影依然有效）。
        // 超过 5 小时的记录虽然仍留在库中，但视为已失效，放行进入。
        //
        // 顺序很重要：被踢时 applyKick 会删除该用户的 roomMember 行，因此被踢者
        // **必然不是成员**。若先判成员资格，他只会收到「你不在该房间中」而拿不到
        // 真正的禁入原因与剩余时间 —— 表现为「点了进入没反应」，用户不知道要等多久。
        // 先判黑名单可以把准确原因回给他。
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

        const member = await prisma.roomMember.findFirst({
          where: {
            roomId: roomIdStr,
            userId: socket.userId!
          }
        });

        if (!member) {
          // 【BUG-02 修复】该用户本房间可能已经在线（另一个标签页仍是成员行）。
          // 之前的顺序会让第二个标签页在这里被拒；而 BUG-02 修复后成员行只在
          // 「该用户最后一个 socket 离开」时才删，这里再补一道兜底：
          // 只要该用户在本房间仍有活跃 socket，就允许其加入，不依赖成员行。
          const onlineUserIds = roomUserIds.get(roomIdStr);
          const userAlreadyOnline = !!socket.userId && !!onlineUserIds?.has(socket.userId);
          if (!userAlreadyOnline) {
            socket.emit('error', { message: '你不在该房间中' });
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

        // 【BUG-03 修复】同一 socket 重复 join-room 时不再重复广播 user-joined。
        //
        // 触发场景：前端在 socket 已连接时会「补发一次 join-room」（房主切页回来复用
        // 已连接的持久 socket，见 RoomView 的 setupWebSocket），
        // 于是同一 socket 会把 user-joined 重复广播给房间内其他人 ——
        // 别人反复看到「同一个人加入」，也可能重复触发建连逻辑。
        // 这里记住「本次之前是否已在该房间」，只对**首次**加入广播。
        // 注意仍然要下发 room-joined 快照：补发 join-room 的目的正是为了拿最新播放状态。
        const alreadyInThisRoom = userRooms.get(socket.id) === roomIdStr;

        userRooms.set(socket.id, roomIdStr);

        if (!isAdmin) {
          if (!roomUsers.has(roomIdStr)) {
            roomUsers.set(roomIdStr, new Set());
          }
          roomUsers.get(roomIdStr)!.add(socket.id);
          // 用户维度去重登记（多标签页只算一个用户）
          trackUserSocket(roomIdStr, socket.userId);

          // 通知房间内其他用户（仅首次加入时广播）
          if (!alreadyInThisRoom) {
            socket.to(roomIdStr).emit('user-joined', {
              userId: socket.userId,
              username: socket.username,
              nickname: socket.nickname,
              socketId: socket.id
            });
          }
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

        // 【播放源持久化】这里**始终**查一次房间的播放源字段，无论内存缓存是否命中。
        // 原因：内存里的 playbackState 只表示「此刻是否正在放映」，房主一暂停它就把
        // playing 置为 false；若只在「内存未命中」时才查库，房主暂停后刷新/切页回来
        // 就再也拿不到自己刚设好的直链，界面回落到「尚未设置播放源」——
        // 这正是「房主一暂停播放源就没了」的根因。
        // 播放源存在 rooms.sourceUrl 列（房主「设为播放源」时即落库），
        // 只有房间被解散（记录删除）时才会随之消失。
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

        // 若房间正在放映，把当前播放状态一并下发，让新观众立即续播而非「等待房主开始播放」。
        // 【需求1】内存未命中时回落到数据库：内存缓存会因服务重启、房主刷新页面
        // （房间瞬间无人）等原因丢失，但播放源已落库，新观众仍应拿到直链续播。
        let playbackState: RoomPlaybackState | null = roomPlaybackStates.get(roomIdStr) || null;
        if (!playbackState) {
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

        // 【播放源持久化】与「是否正在放映」无关，单独下发房主已保存的播放源。
        // 前端据此回填「设为播放源」输入框 —— 房主暂停、刷新、切页、重进房间后，
        // 直链依然在，不需要重新粘贴。房间解散后记录被删除，这里自然是 null。
        const savedSource = dbRoom?.sourceUrl
          ? {
              videoUrl: dbRoom.sourceUrl,
              isHls: dbRoom.sourceIsHls,
              resolution: dbRoom.sourceResolution
            }
          : null;

        // 【需求4A】随 room-joined 一并下发当前生效的广播：
        // 新进房用户无需额外请求或轮询即可看到广播条。
        const broadcast = await getActiveBroadcast();

        socket.emit('room-joined', {
          roomId: roomIdStr,
          users: usersInRoom,
          userCount: roomDistinctUserCount(roomIdStr),
          selfSocketId: socket.id,
          playbackState,
          savedSource,
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

    // 【播放源持久化】房主「设为播放源」：直链一经设定就立即写进房间记录，
    // 不依赖是否已经开始播放。
    // 用户需求：播放源保存在该房间，之后暂停、结束放映、刷新页面、切页、
    // 服务重启都不会丢；只有房间被解散（记录删除）时才随之消失。
    // 与 host-start-play 的区别：本事件**不改变房间状态**（房间可以仍是等待中），
    // 也不向观众下发播放指令，只做「把源存下来」这一件事。
    socket.on('host-set-source', async (data: { roomId: string; videoUrl: string; isHls?: boolean; resolution?: string }) => {
      const room = await requireHost(socket, data?.roomId);
      if (!room) return;

      const url = typeof data?.videoUrl === 'string' ? data.videoUrl.trim() : '';
      // 与 host-start-play 同一套校验口径：非法协议、超长地址一律拒绝，
      // 避免把注定播放不了的地址写进库里、让观众一起失败。
      if (!/^https?:\/\//i.test(url)) {
        socket.emit('error', { message: '视频地址格式无效（仅支持 http/https）' });
        return;
      }
      if (url.length > 8000) {
        socket.emit('error', { message: '视频直链过长（超过 8000 字符），无法保存' });
        return;
      }

      const isHls = !!data.isHls;
      const resolution = typeof data.resolution === 'string' ? data.resolution.slice(0, 20) : null;

      await prisma.room.update({
        where: { id: room.id },
        data: {
          sourceUrl: url,
          sourceIsHls: isHls,
          sourceResolution: resolution,
          sourceUpdatedAt: new Date()
        }
      }).catch((e) => console.error('保存播放源失败:', e));

      // 房间此刻若正在放映，同步内存缓存里的直链（换源不换房的场景），
      // 保证新加入的观众拿到的是房主最新设定的源。
      const st = roomPlaybackStates.get(room.id);
      if (st) {
        st.videoUrl = url;
        st.isHls = isHls;
        st.resolution = resolution;
      }

      // 回执：前端据此给出「已保存到房间」的明确反馈，
      // 避免房主以为点了没生效、反复点。
      socket.emit('source-saved', { roomId: room.id, videoUrl: url, isHls, resolution });
      dbg(`房主为房间 ${room.id} 保存了播放源`);
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

    // 【公共房间需求】电影自然播完 = 本场结束 → 仅作废放映权限。
    //
    // 为什么不复用 host-stop-play：那个事件会连带清空播放源（sourceUrl 等），
    // 会破坏既有行为（播完后想重播同一部片、或暂停后继续都要重新设源）。
    // 本事件**只**释放放映位并保持放映密码处于已作废状态，不碰播放相关字段。
    socket.on('host-screening-end', async (data: { roomId: string }) => {
      if (!requireInRoom(socket, data?.roomId)) return;
      const roomId = data.roomId;
      if (!(await canScreen(roomId, socket.userId!, socket.isAdmin === true))) return;

      // 只有公共房间存在放映位；普通房间这里是空操作
      if (await isPublicRoom(roomId)) {
        await releaseScreening(roomId);
        io.to(roomId).emit('screening-ended', { roomId });
      }
    });

    // 房主一键结束放映（已删除观众投票机制，结束放映由房主直接操作）
    socket.on('host-stop-play', async (data: { roomId: string }) => {
      const room = await requireHost(socket, data?.roomId);
      if (!room) return;

      // 清空内存中的「正在放映」状态缓存，房间回到等待状态
      roomPlaybackStates.delete(room.id);
      lastPositionPersistAt.delete(room.id);

      // 【播放源语义】「结束放映」= 本场作废，**播放源一并清除**（用户 2026-10-14 明确要求）。
      // 与「暂停」严格区分：暂停保留播放源（见 host-pause），只有「结束放映」才清空。
      // 清空后房间回到「尚未设置播放源」，房主要再看需重新粘贴直链。
      // 注意：status 改回 WAITING 且 sourceUrl 置空后，join-room 的 DB 回落条件
      // （status==='PLAYING' && sourceUrl）不再成立，新观众不会被误拉进放映。
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

      // 【公共房间需求】「结束放映」= 本场结束 → 放映权限立即作废：
      // 清空放映人记录、保持放映密码为「已作废」状态（通道回到未设密码），
      // 之后必须由管理员重新设置密码，下一个人才能再走放映通道。
      // 对普通房间而言这个调用是空操作（没有放映人记录），不影响既有行为。
      await releaseScreening(room.id);
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

    socket.on('voice-join', async (roomId: unknown) => {
      // 成员校验：防止向任意房间伪造「某人加入语音」
      if (!requireInRoom(socket, roomId)) return;

      // 【V8 加固】requireInRoom 只证明「信令层加入了该 socket.io 房间」，本身已能
      // 阻止跨房间串流（voice-state 只 socket.to(roomId) 广播）。这里再叠一层
      // 「数据库里确实是该房间成员」的确认，作为纵深防御：
      // 一旦将来信令层的房间加入逻辑被改坏（例如管理员隐身加入、或某个新入口忘了校验），
      // 语音仍然不会漏给房间外的人——语音是隐私敏感能力，值得多这一道。
      try {
        const member = await prisma.roomMember.findFirst({
          where: { roomId, userId: socket.userId },
          select: { id: true }
        });
        if (!member) {
          // 静默拒绝：不回执，避免把「你是否是成员」变成可探测信息
          return;
        }
      } catch (error) {
        // 查询异常时按拒绝处理：宁可让一次加入语音失败，也不要放进身份不明的会话
        console.error('voice-join 成员校验失败:', error);
        return;
      }

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

        // 验证发起者有放映权限（真实房主 / 公共房间的放映人 / 管理员）
        const room = await prisma.room.findUnique({
          where: { id: roomId },
          select: { id: true, hostId: true }
        });
        if (!room) {
          socket.emit('error', { message: '房间不存在' });
          return;
        }
        if (!(await canScreen(roomId, socket.userId!, socket.isAdmin === true))) {
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
    });  });
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

  // 【BUG-02 修复】先判断「这是不是该用户在本房间的最后一个 socket」，再决定是否真正离开。
  //
  // 旧实现无条件按 (roomId, userId) 删成员行，而同一账号开两个标签页时两行合一
  // （unique(roomId,userId)，第二个标签页 /join 返回 alreadyMember）。
  // 于是**任一标签页离开就把整个用户删掉**：大厅人数少 1、凭空腾出一个名额，
  // 而另一个标签页其实还在房间里（信令层 roomUsers 仍有它）。
  // 现在改为：只有当该用户在本房间再无其他 socket 时，才删除成员行并广播 user-left。
  const isLastUserSocket = untrackUserSocket(roomId, socket.id, socket.userId);

  // 【P2】释放数据库成员行（仅在最后一个人离开时）。
  //
  // 旧实现只清理内存映射，**从不删除 room_members 行**。成员行仅在「房主主动离开 /
  // 被踢 / 房间解散」时被删，因此普通观众关闭页面、断网、服务重启后行会永久残留，
  // 造成两类故障：
  //   1) 容量被幽灵占用：join 用 roomMember.count() 判断是否满员，人已走空仍返回
  //      「房间已满」，新观众永远进不来（且没有任何自动回收机制）；
  //   2) 房间列表的人数长期虚高（_count.members 直接来自这张表）。
  // 这里在离开/断连时删除该用户的成员行，使「成员行 == 当前真正在房间内的人」。
  // 注意：房主行同样删除；房主刷新页面会在宽限期内重新 join-room 并重新插入，
  // 而房间解散判定（dissolveRoom）本身是按 roomId 删除全部剩余行的，不受影响。
  if (isLastUserSocket) {
    try {
      await prisma.roomMember.deleteMany({ where: { roomId, userId: socket.userId } });
    } catch (error) {
      // 删除失败会导致名额泄漏，必须留下日志便于排查
      console.error(`释放房间成员行失败（roomId=${roomId}）:`, error);
    }
  } else {
    dbg(`${socket.username} 仍有其他标签页在房间 ${roomId}，保留成员行`);
  }

  // 语音状态与内存名单一并复位（原先依赖 voiceStates 在 911 行被删，
  // 但被踢/断线路径不经过 leaveRoom 的统一出口时容易遗漏，故在此显式声明）
  voiceStates.delete(socket.id);

  // 判断是否是房主在放映途中离开/断线
  let hostAbrupt = false;
  try {
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true, hostId: true, status: true }
    });

    // ===== 【公共房间需求】公共房间永不自动消失 =====
    //
    // 公共房间（管理员创建）必须一直存在，直到管理员在后台手动解散，房间内人数为 0 也不删。
    // 因此这里**整块跳过**原有三套自动解散逻辑：
    //   1) 放映中断线 → 宽限期后解散
    //   2) 房主主动退出 → 立即解散
    //   3) 房主断线（非放映中）→ 宽限期后解散
    // 放映人掉线只走 markScreeningGrace（3 分钟宽限，超时由 reapScreeningHosts 释放权限），
    // 房间本身与放映密码都不受影响。
    const isPublic = room ? await isPublicRoom(roomId) : false;
    if (room && isPublic) {
      // 放映人掉线只记宽限截止时间（3 分钟内连回来仍是放映人）；
      // 若掉线的不是放映人，markScreeningGrace 内部会自行忽略。
      // 注意同样是「最后一个 socket」才记宽限：房主/放映人开着两个标签页时，
      // 关掉其中一个不应让别人以为放映人掉线了。
      if (isLastUserSocket) {
        await markScreeningGrace(roomId, socket.userId!);
      }
    } else if (isLastUserSocket && room && room.status === 'PLAYING' && room.hostId === socket.userId) {
      // 【BUG-02 修复】房主的宽限/解散判定也必须以「最后一个 socket 离开」为准。
      // 否则房主开两个标签页时，关掉一个就会走「房主断线 → 宽限期 → 解散房间」，
      // 而房主其实还在另一个标签页里看 —— 整场放映会被误解散。
      if (voluntary) {
        // 放映途中房主主动解散（HTTP 接口已放行房主随时解散，此处为 socket 兜底）：直接解散
        await dissolveRoom(roomId, { io }).catch(() => {});
      } else {
        // 强行关闭网页导致放映中断：进入宽限期，房主快速重连（如刷新页面）则取消
        hostAbrupt = true;
        scheduleHostLeave(roomId, io, socket.userId!, 'abrupt');
      }
    } else if (isLastUserSocket && room && room.status !== 'PLAYING' && room.hostId === socket.userId) {
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
    const sids = roomUsers.get(roomId)!;
    sids.delete(socket.id);
    if (sids.size === 0) {
      roomUsers.delete(roomId);
      roomUserIds.delete(roomId);
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
  //
  // 【BUG-02 修复】仅当该用户在本房间**已无其他 socket** 时才广播 user-left。
  // 否则一个标签页离开会让所有人以为这个用户离线了（成员栏少人、说话标记消失），
  // 而他在另一个标签页里其实还在看。
  if (!socket.isAdmin && isLastUserSocket) {
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
  roomUserIds.delete(roomId);
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
