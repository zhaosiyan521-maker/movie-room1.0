import express, { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { dissolveRoom } from '../services/roomDissolve';
import { getIO, KICK_BAN_DURATION_MS } from '../services/signaling';
import { UPLOAD_DIR, safeUploadFilename, deleteUnreferencedImages } from '../services/roomImages';

export const roomRouter = Router();

// 所有房间路由都需要认证
roomRouter.use(authMiddleware);

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

// 校验客户端回传的 /uploads/ 路径：必须是合法文件名且指向真实存在的图片
// （合法性判断与路径穿越防护统一由 services/roomImages 提供，避免多处实现漂移）
function resolveUploadPath(p: string): string | null {
  const filename = safeUploadFilename(p);
  if (!filename) return null;
  const abs = path.join(UPLOAD_DIR, filename);
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

    // 【需求1】开设配额：每个「IP + 用户」最多同时拥有 N 个在建房间（WAITING/PLAYING）。
    // N 取自 User.maxRoomsPerIp（管理员在后台按用户配置，默认 1；0 = 禁止开房）。
    // 注意与「加入房间」无关 —— 配额为 0 只是不能自己开房，照样能进别人的房间。
    //
    // IP 取法与登录/注册保持一致：trust proxy 已关闭，直接读 socket 远端地址，
    // 忽略 X-Forwarded-For（否则攻击者可伪造该头绕过配额）。
    const hostIp = String(req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/, '');

    const hostUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { maxRoomsPerIp: true }
    });
    const maxRoomsPerIp = hostUser?.maxRoomsPerIp ?? 1;
    if (maxRoomsPerIp <= 0) {
      return res.status(403).json({ error: '你当前没有开设房间的权限（配额为 0）' });
    }

    // 统计口径：只计入 hostIp 非空的在建房间。本字段上线前创建的历史房间 hostIp 为 null，
    // 若一并计入会白白挤占配额，让老用户建不了新房。
    // 事务外先粗筛一次 —— 正常路径在这里返回，避免图片已落盘后才被拒、产生孤儿文件。
    const activeRoomCount = await prisma.room.count({
      where: {
        hostId: req.user!.id,
        hostIp: { not: null },
        status: { in: ['WAITING', 'PLAYING'] }
      }
    });
    if (activeRoomCount >= maxRoomsPerIp) {
      return res.status(400).json({
        error: `当前 IP 下你最多同时开设 ${maxRoomsPerIp} 个房间，请先解散已有房间再创建`
      });
    }

    // 保存房间图片（最多 5 张）
    const imagePaths = saveImages(images);

    // 【S7】房间名查重与写入置于同一事务。
    // Prisma schema 的 Room.name 没有唯一约束（无法靠数据库兜底并发），
    // 旧实现的 findFirst → create 之间存在竞态窗口，并发请求会同时通过查重，
    // 创建出同名的活跃房间。事务内的读写处于同一序列化边界，可关闭该窗口。
    try {
      const room = await prisma.$transaction(async (tx) => {
        // 【需求1】配额复核：上面的事务外检查与此处之间存在并发窗口，
        // 连点两次建房会同时读到旧房间数、双双通过校验，实际建出超过配额的房间。
        // 事务内的读写处于同一序列化边界，可关闭该窗口。
        const quotaCount = await tx.room.count({
          where: {
            hostId: req.user!.id,
            hostIp: { not: null },
            status: { in: ['WAITING', 'PLAYING'] }
          }
        });
        if (quotaCount >= maxRoomsPerIp) {
          const quota: any = new Error('ROOM_QUOTA_EXCEEDED');
          quota.appCode = 'ROOM_QUOTA_EXCEEDED';
          throw quota;
        }

        const duplicate = await tx.room.findFirst({
          where: {
            name: trimmedName,
            status: { in: ['WAITING', 'PLAYING'] }
          }
        });
        if (duplicate) {
          const dup: any = new Error('ROOM_NAME_DUPLICATE');
          dup.appCode = 'ROOM_NAME_DUPLICATE';
          throw dup;
        }

        // 创建房间
        const created = await tx.room.create({
          data: {
            name: trimmedName,
            description: typeof description === 'string' ? description : null,
            images: imagePaths.length > 0 ? JSON.stringify(imagePaths) : null,
            password: (typeof password === 'string' && password) ? password : null,
            maxViewers: mv,
            hostId: req.user!.id,
            hostIp: hostIp || null,
            status: 'WAITING'
          },
          select: {
            ...ROOM_PUBLIC_SELECT,
            host: { select: ROOM_HOST_SELECT },
            _count: { select: { members: true } },
          }
        });

        // 房主自动加入房间（与建房间同事务，避免建出无人认领的孤儿房间）
        await tx.roomMember.create({
          data: {
            roomId: created.id,
            userId: req.user!.id,
            role: 'HOST'
          }
        });

        return created;
      });

      res.status(201).json({ room: publicRoom(room) });
    } catch (err: any) {
      // 【M5】建库失败（房间名重复 / 配额超限 / 唯一约束冲突）时，刚写入磁盘的图片
      // 不会被任何房间引用，会成为永久孤儿文件。统一实现已带跨房间引用检查，
      // 因此这里可以安全地按「无引用即删除」回收（新文件名是 uuid，不会被他人引用）。
      await deleteUnreferencedImages(imagePaths, []).catch(() => {});

      if (err?.appCode === 'ROOM_NAME_DUPLICATE' || err?.code === 'P2002') {
        return res.status(409).json({ error: '该房间名称已被使用，请换一个' });
      }
      if (err?.appCode === 'ROOM_QUOTA_EXCEEDED') {
        return res.status(400).json({
          error: `当前 IP 下你最多同时开设 ${maxRoomsPerIp} 个房间，请先解散已有房间再创建`
        });
      }
      throw err;
    }
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

    // 【需求4】检查踢出记录：5 小时内不得再次进入该房间。
    // 与 socket 层 join-room 的校验共用 KICK_BAN_DURATION_MS，保证两条入口口径一致。
    // 超过 5 小时的记录视为已过期，放行进入。
    const ban = await prisma.roomBan.findUnique({
      where: { roomId_userId: { roomId, userId } }
    });
    if (ban && Date.now() - new Date(ban.createdAt).getTime() < KICK_BAN_DURATION_MS) {
      const leftMin = Math.ceil(
        (KICK_BAN_DURATION_MS - (Date.now() - new Date(ban.createdAt).getTime())) / 60000
      );
      return res.status(403).json({ error: `你已被房主踢出该房间，还需 ${leftMin} 分钟才能再次进入` });
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
    if (!isHost && !req.user!.isAdmin && room.password && room.password !== password) {
      return res.status(403).json({ error: '房间密码错误' });
    }

    // 【S4】「计数 → 创建成员」必须在同一事务内完成。
    // 旧实现是两条独立语句：并发加入时多个请求会同时读到「未满」，然后都执行 create，
    // 突破 maxViewers 上限；同一用户的并发重复请求还会撞 @@unique([roomId, userId])
    // 唯一约束，最终落到外层 catch 返回 500。这里统一处理为幂等/明确的业务响应。
    const joinResult = await prisma.$transaction(async (tx) => {
      // 事务内重新计数：上面那次快速检查只用于提前给出友好提示，
      // 真正决定是否放行的是事务内这次读（与 create 处在同一序列化边界内）。
      const cnt = await tx.roomMember.count({ where: { roomId } });
      if (cnt >= room.maxViewers) {
        const full: any = new Error('ROOM_FULL');
        full.appCode = 'ROOM_FULL';
        throw full;
      }
      return tx.roomMember.create({
        data: {
          roomId,
          userId,
          role: isHost ? 'HOST' : 'VIEWER'
        }
      });
    }).catch((err: any) => {
      if (err?.appCode === 'ROOM_FULL') return { roomFull: true as const };
      // 并发下同一用户重复加入会撞唯一约束：此时用户确实已是成员，按幂等返回成功
      if (err?.code === 'P2002') return { alreadyMember: true as const };
      throw err;
    });

    if ('roomFull' in joinResult) {
      return res.status(400).json({ error: '房间已满' });
    }
    if ('alreadyMember' in joinResult) {
      return res.json({ message: '成功加入房间', member: null, alreadyMember: true });
    }

    res.json({
      message: '成功加入房间',
      member: joinResult
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

    // 如果是房主，解散房间（房主拥有随时解散权，包括放映途中）
    if (member.role === 'HOST') {
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

    // 【M5】房间行的读取与更新放进同一事务。
    // 旧实现是「事务外读 room → 写新图片 → 按事务外读到的 oldImages 删旧文件」，
    // 两个并发更新会互相破坏：A 读到 oldImages、B 也读到同一份 oldImages，
    // 于是 B 的 update 覆盖 A 之后，A 的清理会删掉 B 刚上传的图片（反过来同理）。
    // 这里把读到的 images 作为乐观并发令牌（compare-and-set），
    // 检测到期间已被他人修改就返回 409，避免静默丢失任一方的更新与文件。
    let updated;
    try {
      updated = await prisma.$transaction(async (tx) => {
        const fresh = await tx.room.findUnique({
          where: { id: room.id },
          select: { images: true }
        });
        if ((fresh?.images ?? null) !== (room.images ?? null)) {
          const conflict: any = new Error('ROOM_IMAGES_CONFLICT');
          conflict.appCode = 'ROOM_IMAGES_CONFLICT';
          throw conflict;
        }
        return tx.room.update({
          where: { id: room.id },
          data: { images: imagePaths.length > 0 ? JSON.stringify(imagePaths) : null }
        });
      });
    } catch (err: any) {
      if (err?.appCode === 'ROOM_IMAGES_CONFLICT') {
        // 本次刚落盘的图片没有任何房间引用，直接回收，避免孤儿文件
        await deleteUnreferencedImages(imagePaths, []).catch(() => {});
        return res.status(409).json({ error: '房间图片刚被其他操作修改，请刷新后重试' });
      }
      throw err;
    }

    // 清理不再被引用的旧图片，避免磁盘泄漏（统一实现内含跨房间引用检查）
    await deleteUnreferencedImages(oldImages, imagePaths, room.id);

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
