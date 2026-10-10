import express, { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/auth';
import { getIO, disconnectUser } from '../services/signaling';

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
        abruptLeaves: true,
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

    // 解散其开设的所有活跃房间
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
    const io = getIO();
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

    // 断开其在线 Socket（实时通道），使其立即掉线
    const io = getIO();
    if (io) disconnectUser(io, target.id, '你的账号已被强制注销');

    // 该用户作为房主开设的房间：先收集图片，再按外键依赖顺序删除关联
    const hostedRooms = await prisma.room.findMany({
      where: { hostId: target.id },
      select: { id: true, images: true }
    });
    const roomIds = hostedRooms.map(r => r.id);
    if (roomIds.length > 0) {
      await prisma.roomMember.deleteMany({ where: { roomId: { in: roomIds } } });
      await prisma.roomBan.deleteMany({ where: { roomId: { in: roomIds } } });
      await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    }
    // 删除房间后清理其图片文件（带跨房间引用检查）
    await purgeRoomImages(hostedRooms);

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
