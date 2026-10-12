import express, { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/auth';
import { getIO, disconnectUser } from '../services/signaling';
import { dissolveRoom } from '../services/roomDissolve';

export const adminRouter = Router();

// 强制注销时清理用户房间图片文件（复用 room.ts 的跨房间引用检查思路，避免误删他人图片）
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const IMG_NAME_RE = /^\/uploads\/([a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|gif))$/;
async function purgeRoomImages(rooms: { images: string | null }[]): Promise<void> {
  try {
    const filenames = new Set<string>();
    for (const r of rooms) {
      if (!r.images) continue;
      try {
        const arr = JSON.parse(r.images);
        if (Array.isArray(arr)) {
          for (const p of arr) {
            if (typeof p === 'string') {
              const m = IMG_NAME_RE.exec(p);
              if (m) filenames.add(m[1]);
            }
          }
        }
      } catch { /* 忽略解析错误 */ }
    }
    for (const fn of filenames) {
      // 若仍被其他房间引用则跳过（uuid 唯一，正常情况下不会；保守处理）
      const others = await prisma.room.findMany({ where: { images: { contains: fn } }, select: { id: true } });
      if (others.length > 0) continue;
      const abs = path.join(UPLOAD_DIR, fn);
      const rel = path.relative(UPLOAD_DIR, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error('清理用户房间图片失败:', e);
  }
}

// 所有管理员路由都需要认证 + 管理员权限
adminRouter.use(authMiddleware, adminMiddleware);
// 解析 JSON 请求体（默认 100kb 上限）
adminRouter.use(express.json());

// 用户列表（含封禁状态）
adminRouter.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const { search } = req.query;
    const keyword = String(search || '').trim().slice(0, 50);

    const users = await prisma.user.findMany({
      where: keyword
        ? {
            OR: [
              { username: { contains: keyword } },
              { nickname: { contains: keyword } },
              { email: { contains: keyword } }
            ]
          }
        : undefined,
      select: {
        id: true,
        username: true,
        nickname: true,
        email: true,
        isAdmin: true,
        banned: true,
        banReason: true,
        bannedAt: true,
        lastIp: true,
        maxRoomsPerIp: true,
        createdAt: true,
        _count: { select: { rooms: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });

    res.json({ users });
  } catch (error) {
    console.error('Admin get users error:', error);
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

// 房间列表：管理员查看/搜索所有用户创建的房间（含已结束），点击可进入（管理员无视密码）
adminRouter.get('/rooms', async (req: AuthRequest, res: Response) => {
  try {
    const { search, status } = req.query;
    const keyword = String(search || '').trim().slice(0, 50);
    const statusFilter = String(status || '').trim().toUpperCase();

    const where: Record<string, unknown> = {};
    if (keyword) {
      where.OR = [
        { name: { contains: keyword } },
        { currentMovie: { contains: keyword } },
        { host: { is: { username: { contains: keyword } } } },
        { host: { is: { nickname: { contains: keyword } } } }
      ];
    }
    if (['WAITING', 'PLAYING', 'ENDED'].includes(statusFilter)) {
      where.status = statusFilter;
    }

    const rooms = await prisma.room.findMany({
      where,
      select: {
        id: true,
        name: true,
        description: true,
        images: true,
        status: true,
        password: true,
        maxViewers: true,
        currentMovie: true,
        createdAt: true,
        updatedAt: true,
        host: { select: { id: true, username: true, nickname: true } },
        _count: { select: { members: true } }
      },
      // 活跃房间靠前，同状态下新的靠前
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 500
    });

    // 只下发是否存在密码，不下发明文
    res.json({
      rooms: rooms.map(r => ({
        ...r,
        password: undefined,
        hasPassword: !!r.password
      }))
    });
  } catch (error) {
    console.error('Admin get rooms error:', error);
    res.status(500).json({ error: '获取房间列表失败' });
  }
});

// 【需求2】管理员解散指定房间：彻底删除房间及其全部关联数据（成员、黑名单、图片文件），
// 并向房间内所有在线用户广播 room-dissolved、请出房间。
// 复用「房主主动解散」完全相同的 roomDissolve 服务，避免两套解散逻辑行为不一致。
adminRouter.post('/rooms/:id/dissolve', async (req: AuthRequest, res: Response) => {
  try {
    const roomId = String(req.params.id || '');
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: {
        id: true,
        name: true,
        status: true,
        host: { select: { nickname: true, username: true } }
      }
    });
    if (!room) {
      return res.status(404).json({ error: '房间不存在或已被解散' });
    }

    const hostName = room.host?.nickname || room.host?.username || '未知用户';
    const ok = await dissolveRoom(roomId, {
      io: getIO(),
      reason: `管理员已解散房间「${room.name}」`
    });
    if (!ok) {
      return res.status(404).json({ error: '房间不存在或已被解散' });
    }

    res.json({ message: `已解散房间「${room.name}」（房主：${hostName}）` });
  } catch (error) {
    console.error('Admin dissolve room error:', error);
    res.status(500).json({ error: '解散房间失败' });
  }
});

// 封禁用户（永久封禁账号 + IP + 邮箱）
adminRouter.post('/users/:id/ban', async (req: AuthRequest, res: Response) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) {
      return res.status(404).json({ error: '用户不存在' });
    }
    if (target.isAdmin) {
      return res.status(400).json({ error: '不能封禁管理员' });
    }
    if (target.id === req.user!.id) {
      return res.status(400).json({ error: '不能封禁自己' });
    }

    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 200)
      : '管理员手动封禁';

    await prisma.user.update({
      where: { id: target.id },
      // tokenVersion 自增：使该用户所有在线/离线 JWT 立即失效
      data: { banned: true, banReason: reason, bannedAt: new Date(), tokenVersion: { increment: 1 } }
    });

    // 封禁其最后登录 IP
    if (target.lastIp) {
      await prisma.bannedIp.upsert({
        where: { ip: target.lastIp },
        create: { ip: target.lastIp, reason, userId: target.id },
        update: { reason, userId: target.id }
      });
    }

    // 【S6】先按「房主正常退出」的语义彻底解散其活跃房间。
    // 旧实现只做 updateMany(status: ENDED) + deleteMany(members)：既不广播 room-dissolved，
    // 也不清理信令内存（roomUsers / roomPlaybackStates / kickVotes）。在线观众会滞留在一个
    // 没有房主的幽灵房间里，画面冻结且收不到任何提示。
    // 这里改为直接复用 dissolveRoom(io)：房间记录、成员、黑名单、图片一并删除，
    // 并向房间内所有在线用户广播 room-dissolved 后将其请出信令房间。
    const io = getIO();
    const activeRooms = await prisma.room.findMany({
      where: { hostId: target.id, status: { in: ['WAITING', 'PLAYING'] } },
      select: { id: true }
    });
    for (const r of activeRooms) {
      await dissolveRoom(r.id, { io, reason: '房主账号已被管理员处置，房间已解散' }).catch(() => {});
    }

    // 余下的非活跃房间（已 END 的历史房间，以及并发创建的新房间）同样收尾
    await prisma.room.updateMany({
      where: { hostId: target.id, status: { in: ['WAITING', 'PLAYING'] } },
      data: { status: 'ENDED' }
    });
    await prisma.roomMember.deleteMany({
      where: { room: { hostId: target.id } }
    });
    await prisma.roomBan.deleteMany({
      where: { userId: target.id }
    });

    // 主动断开其在线 Socket：否则已连接的客户端仍能收发房间广播，
    // 封禁对实时通道形同虚设（authMiddleware 只在下次 HTTP 请求时才拦截）。
    if (io) {
      disconnectUser(io, target.id, '你的账号已被永久封禁');
    }

    res.json({ message: `已永久封禁用户 ${target.username}` });
  } catch (error) {
    console.error('Admin ban user error:', error);
    res.status(500).json({ error: '封禁失败' });
  }
});

// 解除封禁
adminRouter.post('/users/:id/unban', async (req: AuthRequest, res: Response) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) {
      return res.status(404).json({ error: '用户不存在' });
    }

    await prisma.user.update({
      where: { id: target.id },
      data: {
        banned: false,
        banReason: null,
        bannedAt: null,
        abruptLeaves: 0
      }
    });

    // 解除其关联的 IP 封禁
    await prisma.bannedIp.deleteMany({
      where: { userId: target.id }
    });

    res.json({ message: `已解除对用户 ${target.username} 的封禁` });
  } catch (error) {
    console.error('Admin unban user error:', error);
    res.status(500).json({ error: '解除封禁失败' });
  }
});

// 【需求3】调整某用户「每个 IP 同时可开设的房间数」（0–20）。
// 取值 0 表示禁止该用户开设房间 —— 但**不影响其加入他人房间**，这一条不可混为一谈。
adminRouter.post('/users/:id/max-rooms', async (req: AuthRequest, res: Response) => {
  try {
    const raw = req.body?.value;
    // 三层校验缺一不可，后端不能依赖前端已校验过：
    //  ① 空值：Number('') === 0、Number(null) === 0，若不拦，一次缺参请求就会把
    //     用户配额静默改成「禁止开房」。
    //  ② 非数值类型：Number(false) === 0、Number(true) === 1，布尔会被静默当成数字通过；
    //     对象/数组同理（Number([]) === 0）。
    //  ③ 越界：宽松比较下 'abc' < 0 与 'abc' > 20 同时为 false，会绕过范围校验。
    if (
      raw === null || raw === undefined ||
      typeof raw === 'boolean' || typeof raw === 'object' ||
      String(raw).trim() === ''
    ) {
      return res.status(400).json({ error: '开设数量必须是 0 到 20 之间的整数' });
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 20) {
      return res.status(400).json({ error: '开设数量必须是 0 到 20 之间的整数' });
    }

    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, username: true, nickname: true, maxRoomsPerIp: true }
    });
    if (!target) {
      return res.status(404).json({ error: '用户不存在' });
    }

    await prisma.user.update({
      where: { id: target.id },
      data: { maxRoomsPerIp: value }
    });

    const name = target.nickname || target.username;
    res.json({
      message: `已将「${name}」的开设数量从 ${target.maxRoomsPerIp} 改为 ${value}${value === 0 ? '（禁止开房，但不影响加入他人房间）' : ''}`
    });
  } catch (error) {
    console.error('Admin set max rooms error:', error);
    res.status(500).json({ error: '设置开设数量失败' });
  }
});

// 强制注销用户：抹除其全部信息，但允许使用相同邮箱/用户名重新注册。
// 与「封禁」语义不同：封禁保留数据并禁止重注册（封 IP + 加黑名单）；
// 强制注销删除数据且不封 IP、不加黑名单，故 email/username 释放后即可重注册。
adminRouter.post('/users/:id/force-logout', async (req: AuthRequest, res: Response) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) {
      return res.status(404).json({ error: '用户不存在' });
    }
    if (target.isAdmin) {
      return res.status(400).json({ error: '不能强制注销管理员账号' });
    }
    if (target.id === req.user!.id) {
      return res.status(400).json({ error: '不能强制注销自己' });
    }

    // 【S6】先取 io 并解散活跃房间。
    // 旧顺序是「先删库 → 再断连」，而 leaveRoom 依赖 prisma.room.findUnique 判断房主离场行为；
    // 房间已被删 → 整个分支跳过 → 观众收不到 room-dissolved，房间内 socketIds 也不清理，
    // 在线观众永久滞留幽灵房间。必须先解散广播，再删其余数据。
    const io = getIO();
    const activeRooms = await prisma.room.findMany({
      where: { hostId: target.id, status: { in: ['WAITING', 'PLAYING'] } },
      select: { id: true }
    });
    const dissolvedIds = new Set(activeRooms.map(r => r.id));
    for (const r of activeRooms) {
      await dissolveRoom(r.id, { io, reason: '房主账号已被注销，房间已解散' }).catch(() => {});
    }

    // 断开其在线 Socket（实时通道），使其立即掉线
    if (io) disconnectUser(io, target.id, '你的账号已被强制注销');

    // 该用户作为房主开设的房间：先收集图片，再按外键依赖顺序删除关联
    const hostedRooms = await prisma.room.findMany({
      where: { hostId: target.id },
      select: { id: true, images: true }
    });
    // 上面已解散的房间记录已被删除，这里只处理剩余（未活跃）房间，避免重复操作
    const remaining = hostedRooms.filter(r => !dissolvedIds.has(r.id));
    const roomIds = remaining.map(r => r.id);
    if (roomIds.length > 0) {
      await prisma.roomMember.deleteMany({ where: { roomId: { in: roomIds } } });
      await prisma.roomBan.deleteMany({ where: { roomId: { in: roomIds } } });
      await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    }
    // 删除房间后清理其图片文件（带跨房间引用检查）
    await purgeRoomImages(remaining);

    // 该用户作为成员的记录、被房间封禁的记录
    await prisma.roomMember.deleteMany({ where: { userId: target.id } });
    await prisma.roomBan.deleteMany({ where: { userId: target.id } });

    // 清理指向该用户的 IP 封禁记录（仅解除关联避免外键冲突；不新增任何封禁）
    await prisma.bannedIp.deleteMany({ where: { userId: target.id } });

    // 最后删除用户本身（email/username 因记录删除而释放，可重新注册）
    await prisma.user.delete({ where: { id: target.id } });

    res.json({ message: `已强制注销用户 ${target.username}，其全部信息已抹除，该用户可重新注册` });
  } catch (error) {
    console.error('Admin force logout error:', error);
    res.status(500).json({ error: '强制注销失败' });
  }
});

// 已封禁 IP 列表
adminRouter.get('/banned-ips', async (req: AuthRequest, res: Response) => {
  try {
    const ips = await prisma.bannedIp.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500
    });
    res.json({ bannedIps: ips });
  } catch (error) {
    console.error('Admin get banned ips error:', error);
    res.status(500).json({ error: '获取封禁 IP 列表失败' });
  }
});

// 解除某个 IP 的封禁
adminRouter.delete('/banned-ips/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.bannedIp.delete({ where: { id: req.params.id } });
    res.json({ message: '已解除该 IP 的封禁' });
  } catch (error) {
    console.error('Admin delete banned ip error:', error);
    res.status(500).json({ error: '解除 IP 封禁失败' });
  }
});
