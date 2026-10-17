import express, { Router, Response } from 'express';
import { prisma } from '../config/database';
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/auth';
import { getIO, disconnectUser, pushBroadcastUpdate } from '../services/signaling';
import { dissolveRoom } from '../services/roomDissolve';
import { deleteUnreferencedImages, safeUploadFilename } from '../services/roomImages';

export const adminRouter = Router();

/**
 * 强制注销时清理该用户房间的图片文件。
 * 【M5】改为复用 services/roomImages 的统一实现（带跨房间引用检查 + 路径穿越双重校验），
 * 原先此处是第三份重复实现，容易与另外两处产生行为漂移。
 */
async function purgeRoomImages(rooms: { images: string | null }[]): Promise<void> {
  try {
    const refs = new Set<string>();
    for (const r of rooms) {
      if (!r.images) continue;
      try {
        const arr = JSON.parse(r.images);
        if (Array.isArray(arr)) {
          for (const p of arr) {
            if (safeUploadFilename(p)) refs.add(p as string);
          }
        }
      } catch { /* 忽略解析错误 */ }
    }
    // 房间行此时已被删除，因此任意命中都意味着仍被其他房间引用 → 不会被删除
    await deleteUnreferencedImages(Array.from(refs), []);
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

    // 只下发是否存在密码，不下发明文。
    // 注意：必须用解构「剔除」password，不能写 `password: undefined` ——
    // JSON.stringify 会直接丢掉 undefined 值的属性，所以那种写法只是巧合可用，
    // 而 `'password' in room` 仍为 true，容易让后续维护者误判为已安全处理。
    res.json({
      rooms: rooms.map(({ password, ...r }) => ({
        ...r,
        hasPassword: Boolean(password)
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

// ===== 【公共房间需求】后台「公共房间」管理 =====

/**
 * 公共房间列表。
 *
 * 判定口径与需求一致：**管理员账号创建的房间**即公共房间（按 host.isAdmin 判定，
 * 而不是靠房间上的标志位，避免标志位与实际创建者不符的脏数据）。
 * 这里额外返回放映通道状态，便于后台一眼看清当前是「未设密码 / 密码待用 / 放映中」。
 */
adminRouter.get('/public-rooms', async (_req: AuthRequest, res: Response) => {
  try {
    const rooms = await prisma.room.findMany({
      where: { kind: 'PUBLIC' },
      select: {
        id: true,
        name: true,
        status: true,
        // 只取「是否已设置」，绝不把明文放映密码下发给前端
        screeningPassword: true,
        screeningUpdatedAt: true,
        createdAt: true,
        host: { select: { id: true, username: true, nickname: true } },
        _count: { select: { members: true } },
        screeningHosts: {
          select: { userId: true, graceUntil: true, user: { select: { nickname: true, username: true } } }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const now = Date.now();
    res.json({
      rooms: rooms.map(r => {
        const host = r.screeningHosts[0];
        const graceActive = !!host && (!host.graceUntil || host.graceUntil.getTime() > now);
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          createdAt: r.createdAt,
          memberCount: r._count.members,
          owner: r.host?.nickname || r.host?.username || '管理员',
          // 放映通道状态：none=未设密码（通道关闭）/ ready=密码待用 / screening=放映中
          channelState: graceActive ? 'screening' : (r.screeningPassword ? 'ready' : 'none'),
          screeningUser: graceActive
            ? (host!.user?.nickname || host!.user?.username || '未知用户')
            : null,
          screeningGraceUntil: graceActive ? (host!.graceUntil ?? null) : null,
          screeningUpdatedAt: r.screeningUpdatedAt
        };
      })
    });
  } catch (error) {
    console.error('Admin public rooms error:', error);
    res.status(500).json({ error: '获取公共房间列表失败' });
  }
});

/**
 * 设置 / 重置某公共房间的放映通道密码。
 * 传空字符串（或 null）表示清空密码 —— 清空后该房间的放映通道对所有人关闭
 * （管理员除外，管理员始终免密可进）。
 */
adminRouter.post('/public-rooms/:id/screening-password', async (req: AuthRequest, res: Response) => {
  try {
    const { password } = req.body || {};
    if (password !== null && password !== undefined && typeof password !== 'string') {
      return res.status(400).json({ error: '放映密码格式无效' });
    }
    if (typeof password === 'string' && password.length > 64) {
      return res.status(400).json({ error: '放映密码不能超过 64 个字符' });
    }

    const room = await prisma.room.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, kind: true }
    });
    if (!room) return res.status(404).json({ error: '房间不存在或已被解散' });
    if (room.kind !== 'PUBLIC') {
      return res.status(400).json({ error: '该房间不是公共房间' });
    }

    const next = (typeof password === 'string' && password.trim()) ? password.trim() : null;
    await prisma.room.update({
      where: { id: room.id },
      data: { screeningPassword: next, screeningUpdatedAt: new Date() }
    });

    res.json({
      message: next
        ? `已为「${room.name}」设置放映密码（一次性，首位用户使用后立即作废）`
        : `已清除「${room.name}」的放映密码，放映通道对所有人关闭`,
      hasScreeningPassword: Boolean(next)
    });
  } catch (error) {
    console.error('Admin set screening password error:', error);
    res.status(500).json({ error: '设置放映密码失败' });
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
    // 也不清理信令内存（roomUsers / roomPlaybackStates）。在线观众会滞留在一个
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

// ============================================================
// 【需求4A】广播
//   一条循环滚动的弹幕，只出现在观影房间页。永久有效，直到管理员手动停播。
//   下发不走轮询：房间页本身已有 socket 连接，发布后由服务端主动推送。
// ============================================================

// 广播内容与颜色/速度的合法范围（速度与视频弹幕同口径：1~5 档）
const BROADCAST_MAX_LEN = 200;
const BROADCAST_SPEED_MIN = 1;
const BROADCAST_SPEED_MAX = 5;

// 发布广播。同一时间只保留一条生效广播——发布新的会自动停用旧的。
adminRouter.post('/broadcast', async (req: AuthRequest, res: Response) => {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) {
      return res.status(400).json({ error: '广播内容不能为空' });
    }
    if (content.length > BROADCAST_MAX_LEN) {
      return res.status(400).json({ error: `广播内容不能超过 ${BROADCAST_MAX_LEN} 字` });
    }

    // 颜色：仅接受 #RGB / #RRGGBB / #RRGGBBAA 形式的十六进制，非法值回退为白色
    const rawColor = typeof req.body?.color === 'string' ? req.body.color.trim() : '';
    const color = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(rawColor)
      ? rawColor
      : '#ffffff';

    // 速度档位：非整数 / 越界一律回退为默认 3 档，避免把非法值写进库
    const speedRaw = Number(req.body?.speed);
    const speed = Number.isInteger(speedRaw) && speedRaw >= BROADCAST_SPEED_MIN && speedRaw <= BROADCAST_SPEED_MAX
      ? speedRaw
      : 3;

    await prisma.broadcast.updateMany({
      where: { active: true },
      data: { active: false, stoppedAt: new Date() }
    });

    const broadcast = await prisma.broadcast.create({
      data: { content, color, speed, createdBy: req.user!.id }
    });

    // 实时推送给所有在线（房间页）用户，无需等下一次刷新
    await pushBroadcastUpdate();

    res.json({ message: '广播已发布', broadcast });
  } catch (error) {
    console.error('Admin create broadcast error:', error);
    res.status(500).json({ error: '发布广播失败' });
  }
});

// 停播广播（房间页的广播条随即消失并停止滚动）
adminRouter.post('/broadcast/stop', async (req: AuthRequest, res: Response) => {
  try {
    const result = await prisma.broadcast.updateMany({
      where: { active: true },
      data: { active: false, stoppedAt: new Date() }
    });
    await pushBroadcastUpdate();
    res.json({ message: result.count > 0 ? '广播已停播' : '当前没有正在播放的广播' });
  } catch (error) {
    console.error('Admin stop broadcast error:', error);
    res.status(500).json({ error: '停播广播失败' });
  }
});

// 查询当前生效的广播（后台展示状态用）
adminRouter.get('/broadcast', async (_req: AuthRequest, res: Response) => {
  try {
    const broadcast = await prisma.broadcast.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ broadcast });
  } catch (error) {
    console.error('Admin get broadcast error:', error);
    res.status(500).json({ error: '获取广播失败' });
  }
});

// ============================================================
// 【需求4B】公告
//   首屏弹窗形式下发，每名登录用户对同一条公告只显示一次。
// ============================================================

const ANNOUNCEMENT_MAX_LEN = 2000;

// 发布公告
adminRouter.post('/announcements', async (req: AuthRequest, res: Response) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 100) : '';
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) {
      return res.status(400).json({ error: '公告内容不能为空' });
    }
    if (content.length > ANNOUNCEMENT_MAX_LEN) {
      return res.status(400).json({ error: `公告内容不能超过 ${ANNOUNCEMENT_MAX_LEN} 字` });
    }

    const announcement = await prisma.announcement.create({
      data: {
        title: title || null,
        content,
        createdBy: req.user!.id
      }
    });

    res.json({ message: '公告已发布，用户下次访问时可见', announcement });
  } catch (error) {
    console.error('Admin create announcement error:', error);
    res.status(500).json({ error: '发布公告失败' });
  }
});

// 公告列表（含已读人数，便于管理员判断送达情况）
adminRouter.get('/announcements', async (_req: AuthRequest, res: Response) => {
  try {
    const announcements = await prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        content: true,
        createdAt: true,
        _count: { select: { reads: true } }
      }
    });
    res.json({ announcements });
  } catch (error) {
    console.error('Admin get announcements error:', error);
    res.status(500).json({ error: '获取公告列表失败' });
  }
});
