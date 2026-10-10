import express, { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { dissolveRoom } from '../services/roomDissolve';
import { getIO } from '../services/signaling';

export const roomRouter = Router();

// 所有房间路由都需要认证
roomRouter.use(authMiddleware);

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const MAX_IMAGES = 5;

/**
 * 房间公开字段白名单。
 *
 * 安全要点：绝不能用 `include` 查询房间——Prisma 的 include 会返回全部标量字段，
 * 其中包含明文 password。任何登录用户都能从房间列表/详情接口读到所有房间的密码，
 * 加入房间的密码校验形同虚设。
 */
const ROOM_PUBLIC_SELECT = {
  id: true,
  name: true,
  description: true,
  images: true,
  status: true,
  maxViewers: true,
  currentMovie: true,
  createdAt: true,
  updatedAt: true,
  password: true, // 仅用于计算 hasPassword，不下发原值
} as const;

const ROOM_HOST_SELECT = {
  id: true,
  username: true,
  nickname: true,
} as const;

/** 把 password 转成 hasPassword 布尔值后输出，绝不把明文密码发给客户端 */
function publicRoom<T extends { password?: string | null }>(room: T): Omit<T, 'password'> & { hasPassword: boolean } {
  const { password, ...rest } = room;
  return { ...rest, hasPassword: Boolean(password) };
}

function publicRooms<T extends { password?: string | null }>(rooms: T[]) {
  return rooms.map(publicRoom);
}

/** 解析并校验分页参数，防止 NaN / 超大 limit 拖垮数据库 */
function parsePagination(page: unknown, limit: unknown): { page: number; limit: number } | null {
  const p = parseInt(String(page ?? '1'), 10);
  const l = parseInt(String(limit ?? '20'), 10);
  if (!Number.isFinite(p) || !Number.isFinite(l)) return null;
  return {
    page: Math.min(Math.max(p, 1), 100_000),
    limit: Math.min(Math.max(l, 1), 50), // 上限 50，防止一次性拉全表
  };
}

// 保存 base64 图片到 uploads 目录，返回访问路径
function saveBase64Image(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
  if (!match) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 3 * 1024 * 1024) return null; // 单张最大 3MB
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
  const filename = `${uuidv4()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  return `/uploads/${filename}`;
}

// 校验客户端回传的 /uploads/ 路径：必须指向上传目录内真实存在的图片文件，
// 避免任意路径注入或引用不存在/他人的文件
function resolveUploadPath(p: string): string | null {
  if (typeof p !== 'string' || !p.startsWith('/uploads/')) return null;
  const filename = p.slice('/uploads/'.length);
  if (!/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/.test(filename)) return null;
  const abs = path.join(UPLOAD_DIR, filename);
  const rel = path.relative(UPLOAD_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(abs)) return null;
  return p;
}

function saveImages(images: any): string[] {
  if (!Array.isArray(images)) return [];
  const saved: string[] = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    if (typeof img === 'string' && img.startsWith('data:image/')) {
      const p = saveBase64Image(img);
      if (p) saved.push(p);
    } else if (typeof img === 'string' && img.startsWith('/uploads/')) {
      const p = resolveUploadPath(img);
      if (p) saved.push(p);
    }
  }
  return saved;
}

/**
 * 删除不再被引用的旧图片文件，避免磁盘泄漏。
 *
 * 安全要点：必须检查该图片是否仍被「其他房间」引用。
 * 否则攻击者可把别人的图片路径填进自己房间，再移除它，
 * 就会把他人房间正在使用的图片从磁盘删除（跨房间删图）。
 */
async function deleteOrphanImages(oldImages: string[], keepImages: string[], currentRoomId?: string) {
  const keep = new Set(keepImages);
  for (const old of oldImages) {
    if (keep.has(old)) continue;

    const filename = old.replace('/uploads/', '');
    // 再次校验文件名格式，防止 old 中混入非 uploads 路径
    if (!/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/.test(filename)) continue;

    const abs = path.join(UPLOAD_DIR, filename);
    const rel = path.relative(UPLOAD_DIR, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;

    // 若仍被其他房间引用，跳过删除
    try {
      const others = await prisma.room.findMany({
        where: {
          images: { contains: filename },
          ...(currentRoomId ? { id: { not: currentRoomId } } : {}),
        },
        select: { id: true }
      });
      if (others.length > 0) continue;
    } catch {
      // 查询失败时保守处理：不删除，避免误伤他人图片
      continue;
    }

    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* 忽略删除失败 */
    }
  }
}

function parseImages(images: string | null): string[] {
  if (!images) return [];
  try {
    const arr = JSON.parse(images);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 创建房间（含图片上传，单独放开到 20mb）
roomRouter.post('/', express.json({ limit: '20mb' }), async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, password, maxViewers = 30, images } = req.body;

    // 房间名：先 trim 再判空，避免全空格（truthy）绕过校验建出空名房间
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      return res.status(400).json({ error: '房间名称为必填项' });
    }
    if (trimmedName.length > 50) {
      return res.status(400).json({ error: '房间名称不能超过 50 个字符' });
    }

    // maxViewers：宽松比较下 "abc" < 1 与 "abc" > 30 均为 false，会绕过校验，
    // 故必须显式转数字并校验为整数
    const mv = Number(maxViewers);
    if (!Number.isInteger(mv) || mv < 1 || mv > 30) {
      return res.status(400).json({ error: '观众数量必须在 1-30 人之间' });
    }

    if (password !== undefined && password !== null && typeof password !== 'string') {
      return res.status(400).json({ error: '房间密码格式无效' });
    }
    if (typeof password === 'string' && password.length > 64) {
      return res.status(400).json({ error: '房间密码不能超过 64 个字符' });
    }
    if (typeof description === 'string' && description.length > 500) {
      return res.status(400).json({ error: '房间描述不能超过 500 个字符' });
    }

    // 房间名称全局唯一（活跃房间内不允许重复）
    const duplicate = await prisma.room.findFirst({
      where: {
        name: trimmedName,
        status: { in: ['WAITING', 'PLAYING'] }
      }
    });
    if (duplicate) {
      return res.status(409).json({ error: '该房间名称已被使用，请换一个' });
    }

    // 保存房间图片（最多 5 张）
    const imagePaths = saveImages(images);

    // 创建房间
    const room = await prisma.room.create({
      data: {
        name: trimmedName,
        description: typeof description === 'string' ? description : null,
        images: imagePaths.length > 0 ? JSON.stringify(imagePaths) : null,
        password: (typeof password === 'string' && password) ? password : null,
        maxViewers: mv,
        hostId: req.user!.id,
        status: 'WAITING'
      },
      select: {
        ...ROOM_PUBLIC_SELECT,
        host: { select: ROOM_HOST_SELECT },
        _count: { select: { members: true } },
      }
    });

    // 房主自动加入房间
    await prisma.roomMember.create({
      data: {
        roomId: room.id,
        userId: req.user!.id,
        role: 'HOST'
      }
    });

    res.status(201).json({ room: publicRoom(room) });
  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ error: '创建房间失败' });
  }
});

// 获取房间列表（支持搜索房间名称 / 房主用户名 / 房主昵称）
roomRouter.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, page = '1', limit = '20', search } = req.query;

    const paging = parsePagination(page, limit);
    if (!paging) {
      return res.status(400).json({ error: '分页参数无效' });
    }

    const allowedStatus = ['WAITING', 'PLAYING', 'ENDED'];
    const rawStatus = typeof status === 'string' && status ? status.toUpperCase() : '';
    if (rawStatus && !allowedStatus.includes(rawStatus)) {
      return res.status(400).json({ error: '房间状态参数无效' });
    }

    const where: any = {
      status: rawStatus || { in: ['WAITING', 'PLAYING'] }
    };

    const keyword = String(search || '').trim();
    if (keyword) {
      where.OR = [
        { name: { contains: keyword } },
        { host: { username: { contains: keyword } } },
        { host: { nickname: { contains: keyword } } }
      ];
    }

    const rooms = await prisma.room.findMany({
      where,
      select: {
        ...ROOM_PUBLIC_SELECT,
        host: { select: ROOM_HOST_SELECT },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (paging.page - 1) * paging.limit,
      take: paging.limit,
    });

    const total = await prisma.room.count({ where });

    res.json({
      rooms: publicRooms(rooms),
      pagination: {
        page: paging.page,
        limit: paging.limit,
        total,
        pages: Math.ceil(total / paging.limit),
      }
    });
  } catch (error) {
    console.error('Get rooms error:', error);
    res.status(500).json({ error: '获取房间列表失败' });
  }
});

// 获取单个房间详情
roomRouter.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const room = await prisma.room.findUnique({
      where: { id: req.params.id },
      select: {
        ...ROOM_PUBLIC_SELECT,
        hostId: true,   // 供前端判断自己是否房主
        host: { select: ROOM_HOST_SELECT },
        members: {
          select: {
            id: true,
            role: true,
            joinedAt: true,
            user: {
              select: { id: true, username: true, nickname: true, avatar: true }
            }
          }
        },
        _count: { select: { members: true } }
      }
    });

    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    res.json({ room: publicRoom(room) });
  } catch (error) {
    console.error('Get room error:', error);
    res.status(500).json({ error: '获取房间详情失败' });
  }
});

// 加入房间（验证密码）
roomRouter.post('/:id/join', express.json(), async (req: AuthRequest, res: Response) => {
  try {
    const { password } = req.body;
    const roomId = req.params.id;
    const userId = req.user!.id;

    // 查询房间（显式 select，避免密码随响应外泄）
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: {
        id: true,
        name: true,
        status: true,
        hostId: true,
        maxViewers: true,
        password: true,
        members: {
          where: { userId },
          select: { id: true, role: true, joinedAt: true }
        }
      }
    });

    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    if (room.status === 'ENDED') {
      return res.status(400).json({ error: '房间已结束' });
    }

    // 已经是房间成员（包括房主），直接放行进入
    if (room.members.length > 0) {
      return res.json({
        message: '成功加入房间',
        member: room.members[0],
        alreadyMember: true
      });
    }

    // 检查是否被投票踢出（本场电影禁止再进）
    const ban = await prisma.roomBan.findUnique({
      where: { roomId_userId: { roomId, userId } }
    });
    if (ban) {
      return res.status(403).json({ error: '你已被投票踢出该房间，本场电影无法再次进入' });
    }

    // 统计当前房间总人数（房主也占一个名额）
    const memberCount = await prisma.roomMember.count({ where: { roomId } });
    if (memberCount >= room.maxViewers) {
      return res.status(400).json({ error: '房间已满' });
    }

    // 验证密码（房主本人不需要密码）
    const isHost = room.hostId === userId;

    // 密码仅在「传了值」时校验格式。
    // 无密码房间的客户端可能不传 password 字段（值为 undefined），
    // 若此处把非 string 一律判为无效，会导致无密码房间任何人都无法加入。
    if (password !== undefined && password !== null) {
      if (typeof password !== 'string' || password.length > 64) {
        return res.status(400).json({ error: '房间密码格式无效' });
      }
    }
    if (!isHost && room.password && room.password !== password) {
      return res.status(403).json({ error: '房间密码错误' });
    }

    // 加入房间
    const member = await prisma.roomMember.create({
      data: {
        roomId,
        userId,
        role: isHost ? 'HOST' : 'VIEWER'
      }
    });

    res.json({
      message: '成功加入房间',
      member
    });
  } catch (error) {
    console.error('Join room error:', error);
    res.status(500).json({ error: '加入房间失败' });
  }
});

// 离开房间
roomRouter.post('/:id/leave', async (req: AuthRequest, res: Response) => {
  try {
    const roomId = req.params.id;
    const userId = req.user!.id;

    // 检查是否在房间中
    const member = await prisma.roomMember.findUnique({
      where: {
        roomId_userId: { roomId, userId }
      }
    });

    if (!member) {
      return res.status(400).json({ error: '你不在该房间中' });
    }

    // 如果是房主，解散房间
    if (member.role === 'HOST') {
      const room = await prisma.room.findUnique({ where: { id: roomId } });

      // 放映途中不允许解散房间
      if (room?.status === 'PLAYING') {
        return res.status(400).json({ error: '放映途中不能解散房间，请先结束放映' });
      }

      // 房主退出（含放映已结束的房间）：彻底解散并删除房间，
      // 服务器端不保留任何历史记录（房间/成员/黑名单/图片全部清除）
      const io = getIO();
      await dissolveRoom(roomId, { io });

      return res.json({ message: '房间已解散' });
    }

    // 普通成员离开
    await prisma.roomMember.delete({
      where: { id: member.id }
    });

    res.json({ message: '已离开房间' });
  } catch (error) {
    console.error('Leave room error:', error);
    res.status(500).json({ error: '离开房间失败' });
  }
});

// 房间状态白名单
const ROOM_STATUSES = ['WAITING', 'PLAYING', 'ENDED'] as const;

// 更新房间状态（开始播放/结束播放）
roomRouter.patch('/:id/status', express.json(), async (req: AuthRequest, res: Response) => {
  try {
    const { status, currentMovie } = req.body;
    const roomId = req.params.id;

    // 验证是房主
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true, hostId: true, status: true, currentMovie: true }
    });

    if (!room || room.hostId !== req.user!.id) {
      return res.status(403).json({ error: '只有房主可以操作' });
    }

    // 状态白名单校验：原先 `status || room.status` 会把任意字符串写入库中
    let nextStatus = room.status;
    if (status !== undefined) {
      if (typeof status !== 'string' || !ROOM_STATUSES.includes(status as any)) {
        return res.status(400).json({ error: '房间状态无效' });
      }
      nextStatus = status;
    }

    if (currentMovie !== undefined) {
      if (typeof currentMovie !== 'string' || currentMovie.length > 200) {
        return res.status(400).json({ error: '电影名称无效或过长' });
      }
    }

    const updatedRoom = await prisma.room.update({
      where: { id: roomId },
      select: { ...ROOM_PUBLIC_SELECT, hostId: true },
      data: {
        status: nextStatus,
        currentMovie: currentMovie !== undefined ? (currentMovie || null) : room.currentMovie
      }
    });

    res.json({ room: publicRoom(updatedRoom) });
  } catch (error) {
    console.error('Update room status error:', error);
    res.status(500).json({ error: '更新房间状态失败' });
  }
});

// 更新房间图片（仅房主，最多 5 张）
roomRouter.put('/:id/images', express.json({ limit: '20mb' }), async (req: AuthRequest, res: Response) => {
  try {
    const room = await prisma.room.findUnique({ where: { id: req.params.id } });
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    if (room.hostId !== req.user!.id) {
      return res.status(403).json({ error: '只有房主可以修改房间图片' });
    }

    const oldImages = parseImages(room.images);
    const imagePaths = saveImages(req.body.images);

    const updated = await prisma.room.update({
      where: { id: room.id },
      data: { images: imagePaths.length > 0 ? JSON.stringify(imagePaths) : null }
    });

    // 清理不再被引用的旧图片，避免磁盘泄漏（需排除当前房间自身的引用）
    await deleteOrphanImages(oldImages, imagePaths, room.id);

    res.json({ images: parseImages(updated.images) });
  } catch (error) {
    console.error('Update room images error:', error);
    res.status(500).json({ error: '更新房间图片失败' });
  }
});

// 获取我创建的房间
roomRouter.get('/my/hosts', async (req: AuthRequest, res: Response) => {
  try {
    const rooms = await prisma.room.findMany({
      where: { hostId: req.user!.id },
      select: {
        ...ROOM_PUBLIC_SELECT,
        hostId: true,
        _count: { select: { members: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    res.json({ rooms: publicRooms(rooms) });
  } catch (error) {
    console.error('Get my rooms error:', error);
    res.status(500).json({ error: '获取我的房间失败' });
  }
});

// 获取我加入的房间
roomRouter.get('/my/joined', async (req: AuthRequest, res: Response) => {
  try {
    const memberships = await prisma.roomMember.findMany({
      where: {
        userId: req.user!.id,
        role: 'VIEWER'
      },
      select: {
        room: {
          select: {
            ...ROOM_PUBLIC_SELECT,
            hostId: true,
            host: { select: ROOM_HOST_SELECT },
            _count: { select: { members: true } }
          }
        }
      },
      orderBy: { joinedAt: 'desc' },
      take: 100
    });

    res.json({ rooms: publicRooms(memberships.map(m => m.room)) });
  } catch (error) {
    console.error('Get joined rooms error:', error);
    res.status(500).json({ error: '获取加入的房间失败' });
  }
});
