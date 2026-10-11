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
// 踢出投票：roomId -> targetUserId -> { agrees, declines, targetName }
const kickVotes = new Map<string, Map<string, { agrees: Set<string>; declines: Set<string>; targetName: string }>>();

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

// 统计房间内「去重后的真实用户数」（按 userId 去重），避免同一用户多开标签刷高投票阈值
function distinctUserCount(io: Server, roomId: string): number {
  const set = roomUsers.get(roomId);
  if (!set) return 0;
  const users = new Set<string>();
  for (const sid of set) {
    const s = io.sockets.sockets.get(sid) as AuthenticatedSocket | undefined;
    if (s?.userId) users.add(s.userId);
  }
  return users.size;
}

// 踢人 / 放映投票阈值：不足 5 人时 1 票即可，否则向上取整为 1/3
function voteThreshold(total: number): number {
  if (total <= 0) return Number.MAX_SAFE_INTEGER; // 空房间不应通过任何投票
  if (total < 5) return 1;
  return Math.max(1, Math.ceil(total / 3));
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
      next();
    } catch (error) {
      next(new Error('认证失败'));
    }
  });

  /**
   * 校验某 socket 是否确实已加入该房间。
   * 用于所有需要「房间成员身份」的事件：聊天、语音、投票、WebRTC 信令。
   * 缺少这一步会让任意登录用户向任意房间注入事件（跨房间刷屏、伪造他人状态、
   * 场外操纵踢出/放映投票、向他人注入 SDP/ICE 干扰其连接）。
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

        // 检查黑名单（被投票踢出的用户本场电影禁止进入）
        const ban = await prisma.roomBan.findUnique({
          where: { roomId_userId: { roomId: roomIdStr, userId: socket.userId! } }
        });
        if (ban) {
          socket.emit('kicked', { roomId: roomIdStr, reason: '你已被投票踢出该房间，本场电影无法再次进入' });
          return;
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

        if (!roomUsers.has(roomIdStr)) {
          roomUsers.set(roomIdStr, new Set());
        }
        roomUsers.get(roomIdStr)!.add(socket.id);
        userRooms.set(socket.id, roomIdStr);

        // 通知房间内其他用户
        socket.to(roomIdStr).emit('user-joined', {
          userId: socket.userId,
          username: socket.username,
          nickname: socket.nickname,
          socketId: socket.id
        });

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

        // 若房间正在放映，把当前播放状态一并下发，让新观众立即续播而非「等待房主开始播放」
        const playbackState = roomPlaybackStates.get(roomIdStr) || null;

        socket.emit('room-joined', {
          roomId: roomIdStr,
          users: usersInRoom,
          userCount: roomUsers.get(roomIdStr)?.size || 0,
          selfSocketId: socket.id,
          playbackState
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

      // movieName 仅用于展示与落库（可直接等于网络直链 URL），不做长度硬截断，
      // 否则超过 200 字符的直链会被整体拒绝，导致"点了播放观众端毫无反应"。
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

      socket.to(room.id).emit('playback-start', {
        hostId: socket.userId,
        movieName: data.movieName.slice(0, 200),
        resolution: typeof data.resolution === 'string' ? data.resolution.slice(0, 20) : null,
        // 直链可能较长，保留完整地址（上限 4000 字符，避免极端超长请求）
        videoUrl: typeof data.videoUrl === 'string' ? data.videoUrl.slice(0, 4000) : null,
        isHls: !!data.isHls
      });

      prisma.room.update({
        where: { id: room.id },
        data: {
          status: 'PLAYING',
          currentMovie: data.movieName
        }
      }).catch(console.error);
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

      await prisma.room.update({
        where: { id: room.id },
        data: { status: 'WAITING' }
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

      // 更新房间播放状态缓存的进度，供新观众加入时续播
      const st = roomPlaybackStates.get(room.id);
      if (st) {
        st.currentTime = Math.max(0, currentTime);
        st.duration = Math.max(0, duration);
      }

      socket.to(room.id).emit('progress-sync', {
        currentTime: Math.max(0, currentTime),
        duration: Math.max(0, duration)
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

    // ===== 房主发起踢出（房间内 1/3 的人同意即踢出） =====

    // 房主发起踢出投票
    socket.on('kick-request', async (data: { roomId: string; targetUserId: string }) => {
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
          socket.emit('error', { message: '只有房主可以发起踢出' });
          return;
        }

        if (targetUserId === socket.userId) {
          socket.emit('error', { message: '不能踢出自己' });
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

        if (!kickVotes.has(roomId)) {
          kickVotes.set(roomId, new Map());
        }
        kickVotes.get(roomId)!.set(targetUserId, {
          agrees: new Set([socket.userId!]), // 房主发起即视为同意
          declines: new Set(),
          targetName
        });

        const total = distinctUserCount(io, roomId);
        const needed = voteThreshold(total);
        if (needed === Number.MAX_SAFE_INTEGER) return;

        // 向房间内其他人（除房主和目标）发起确认弹窗
        socket.to(roomId).emit('kick-vote-request', {
          targetUserId,
          targetName,
          needed,
          total
        });

        // 检查是否直接满足条件（比如房间只有房主和目标两人）
        await checkKickVotes(io, roomId, targetUserId);
      } catch (error) {
        console.error('Kick request error:', error);
        socket.emit('error', { message: '发起踢出失败' });
      }
    });

    // 观众回应踢出投票（是/否）
    socket.on('kick-vote', async (data: { roomId: string; targetUserId: string; agree: boolean }) => {
      try {
        // 成员校验：防止场外用户操纵任意房间的踢出投票
        if (!requireInRoom(socket, data?.roomId)) return;
        const { roomId, targetUserId, agree } = data;
        if (typeof targetUserId !== 'string') return;

        const vote = kickVotes.get(roomId)?.get(targetUserId);
        if (!vote) return;

        // 目标本人不参与投票
        if (socket.userId === targetUserId) return;

        // 同一用户改票时从另一侧移除，避免同时计入 agrees 与 declines
        const userId = socket.userId!;
        vote.agrees.delete(userId);
        vote.declines.delete(userId);
        if (agree) vote.agrees.add(userId);
        else vote.declines.add(userId);

        await checkKickVotes(io, roomId, targetUserId);
      } catch (error) {
        console.error('Kick vote error:', error);
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

// 检查踢出投票是否达到 1/3 同意
async function checkKickVotes(io: Server, roomId: string, targetUserId: string) {
  const vote = kickVotes.get(roomId)?.get(targetUserId);
  if (!vote) return;

  const total = distinctUserCount(io, roomId);
  const needed = voteThreshold(total);

  if (needed !== Number.MAX_SAFE_INTEGER && vote.agrees.size >= needed) {
    const targetName = vote.targetName;
    kickVotes.get(roomId)?.delete(targetUserId);

    // 写入黑名单（本场电影禁止再进）
    await prisma.roomBan.upsert({
      where: { roomId_userId: { roomId, userId: targetUserId } },
      create: { roomId, userId: targetUserId, reason: '投票踢出' },
      update: {}
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
        s.emit('kicked', { roomId, reason: '你已被投票踢出该房间，本场电影无法再次进入' });
        await leaveRoom(s as AuthenticatedSocket, roomId, io);
      }
    }

    io.to(roomId).emit('kick-vote-result', {
      targetUserId,
      targetName,
      kicked: true,
      agrees: vote.agrees.size,
      needed,
      total
    });

    dbg(`用户 ${targetName} 在房间 ${roomId} 被投票踢出（同意 ${vote.agrees.size}/${total}）`);
  }
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
      kickVotes.delete(roomId);
      roomPlaybackStates.delete(roomId);
    }
  }

  userRooms.delete(socket.id);
  voiceStates.delete(socket.id);
  lastChatTime.delete(socket.id);
  lastSpeakingAt.delete(socket.id);

  // 通知房间内其他用户
  socket.to(roomId).emit('user-left', {
    userId: socket.userId,
    username: socket.username,
    nickname: socket.nickname,
    socketId: socket.id,
    hostAbrupt
  });

  dbg(`${socket.username} 离开了房间 ${roomId}`);
}

// 房主放映中断线去重：同一用户同一房间 10 秒内的重复断线只计一次。
// 房主若开了多个标签页，一次断网会在同一瞬间触发多个 socket 的 disconnect，
// 原实现会各自 +1，导致 abruptLeaves 瞬间达到阈值而误封号。
const ABRUPT_DEDUPE_MS = 10_000;
const recentAbrupt = new Map<string, number>();

// 定期清理去重记录
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentAbrupt) {
    if (now - ts > ABRUPT_DEDUPE_MS) recentAbrupt.delete(key);
  }
}, 60 * 1000).unref();

// 房主放映中断线：累计次数，达到上限永久封禁
async function handleHostAbruptLeave(io: Server, roomId: string, hostUserId: string) {
  try {
    const dedupeKey = `${roomId}:${hostUserId}`;
    const now = Date.now();
    const lastAt = recentAbrupt.get(dedupeKey) || 0;
    if (now - lastAt < ABRUPT_DEDUPE_MS) return;   // 重复断线，忽略
    recentAbrupt.set(dedupeKey, now);

    const user = await prisma.user.update({
      where: { id: hostUserId },
      data: { abruptLeaves: { increment: 1 } }
    });

    // 结束本场放映，房间回到等待状态
    await prisma.room.update({
      where: { id: roomId },
      data: { status: 'WAITING' }
    }).catch(() => {});

    roomPlaybackStates.delete(roomId); // 放映中断，清空播放状态

    io.to(roomId).emit('host-disconnected', {
      message: '房主连接中断，放映已结束'
    });

    dbg(`房主 ${user.username} 放映中断线（第 ${user.abruptLeaves} 次）`);

    // 自动封禁：管理员（白名单）不受封禁制约，即使断线次数超限也不封禁。
    if (user.abruptLeaves >= config.maxAbruptLeaves && !user.banned && !user.isAdmin) {
      const reason = `放映途中强行中断 ${user.abruptLeaves} 次，被系统永久封禁`;
      await prisma.user.update({
        where: { id: hostUserId },
        // tokenVersion 自增：封禁同时使该用户所有 JWT 失效
        data: { banned: true, banReason: reason, bannedAt: new Date(), tokenVersion: { increment: 1 } }
      });

      // 封禁其 IP
      if (user.lastIp) {
        await prisma.bannedIp.upsert({
          where: { ip: user.lastIp },
          create: { ip: user.lastIp, reason, userId: hostUserId },
          update: { reason, userId: hostUserId }
        });
      }

      // 解散其所有活跃房间
      await prisma.room.updateMany({
        where: { hostId: hostUserId, status: { in: ['WAITING', 'PLAYING'] } },
        data: { status: 'ENDED' }
      });
      await prisma.roomMember.deleteMany({
        where: { room: { hostId: hostUserId } }
      });

      // 断开其在线连接，避免封禁后仍能收发房间广播
      disconnectUser(io, hostUserId, '你的账号已被永久封禁');

      dbg(`用户 ${user.username} 已被永久封禁（IP: ${user.lastIp}）`);
    }
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
