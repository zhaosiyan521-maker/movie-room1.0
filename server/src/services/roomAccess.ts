/**
 * 公共房间的放映权限判定（本次「公共放映厅」需求的核心）。
 *
 * ===== 背景与术语 =====
 * 管理员账号创建的房间 = 「公共房间」。它多出一条「放映通道」：
 *   - 非管理员必须输入**一次性放映密码**才能通过，且只有第一个人能通过（密码用过即废）；
 *   - 管理员免密通过，且**不消耗**密码（否则管理员一次误点就把授权名额用掉了）；
 *   - 通过者成为「放映人」，获得与房主一致的放映权限（唯独不能解散房间）。
 *
 * ===== 为什么需要这个模块 =====
 * 改造前 `hostId` 是**唯一**权限源，全项目散布着 `room.hostId === userId` 的硬校验
 * （signaling 的 requireHost / kick-user / leaveRoom，routes 的 /status、/images）。
 * 引入放映人后，「有效房主」变成三选一：真实房主、放映人、管理员。与其把判断散落各处，
 * 这里统一收口，避免将来再加一个入口时又漏改某处。
 *
 * ===== 宽限期 =====
 * 放映人掉线（刷新页面、网络抖动）不立即释放权限，而是记 graceUntil = now + 3 分钟，
 * 让他能回来继续放映。超时后由 reapScreeningHosts 清理：删除记录、置空放映密码、
 * 房间回到 WAITING —— 即「通道回到未设密码状态」，需管理员重新设密码。
 */
import { prisma } from '../config/database';

/** 掉线后保留放映权限的宽限期（毫秒） */
export const SCREENING_GRACE_MS = 3 * 60 * 1000;

export interface RoomForAccess {
  id: string;
  hostId: string;
  screeningPassword?: string | null;
}

/**
 * 是否为「公共房间」。
 *
 * 判定依据是「创建者是否为管理员」，而不是房间上的某个标志位：
 * 这样与需求「管理员账户创建的房间」严格一致，也不会出现「标志位与实际创建者不符」的脏数据。
 * 注意必须查库拿 isAdmin —— 调用方传入的 room 对象通常不含该字段。
 */
export async function isPublicRoom(roomId: string): Promise<boolean> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { host: { select: { isAdmin: true } } }
  });
  return room?.host?.isAdmin === true;
}

/** 批量判定（房间列表用）：返回 hostId 为管理员的房间 id 集合 */
export async function publicRoomIds(roomIds: string[]): Promise<Set<string>> {
  if (roomIds.length === 0) return new Set();
  const rooms = await prisma.room.findMany({
    where: { id: { in: roomIds } },
    select: { id: true, host: { select: { isAdmin: true } } }
  });
  return new Set(rooms.filter(r => r.host?.isAdmin === true).map(r => r.id));
}

/**
 * 取房间当前有效的放映人 userId。
 * 宽限期已过（graceUntil 早于当前时间）视为**已释放**，返回 null。
 * 这里做兜底判定，而不是只依赖定时清理 —— 定时器有最小间隔，不能作为正确性依据。
 */
export async function getActiveScreeningHost(roomId: string): Promise<string | null> {
  const row = await prisma.roomScreeningHost.findUnique({
    where: { roomId },
    select: { userId: true, graceUntil: true }
  });
  if (!row) return null;
  if (row.graceUntil && row.graceUntil.getTime() <= Date.now()) return null;
  return row.userId;
}

/**
 * 【权限总判定】该用户此刻是否有「放映权限」（≈房主权限，但不可解散房间）。
 *
 * 三类人通过：
 *   1) 管理员               —— 永远有，便于随时接管；
 *   2) 房间真实房主         —— 普通房间的既有行为完全不变；
 *   3) 当前有效放映人       —— 公共房间通过放映通道进入的那个人。
 *
 * 注意：房主对自己房间的权限**不因房间是公共房间而被剥夺** ——
 * 公共房间的房主就是管理员，管理员本就在第 1 类里。
 */
export async function canScreen(roomId: string, userId: string, isAdmin = false): Promise<boolean> {
  if (isAdmin) return true;
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { hostId: true }
  });
  if (!room) return false;
  if (room.hostId === userId) return true;
  return (await getActiveScreeningHost(roomId)) === userId;
}

/** 该用户是否有权解散房间：仅管理员与真实房主（放映人**不可**解散） */
export async function canDissolve(roomId: string, userId: string, isAdmin = false): Promise<boolean> {
  if (isAdmin) return true;
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { hostId: true }
  });
  return !!room && room.hostId === userId;
}

export type ClaimResult =
  | { ok: true; asAdmin: boolean }
  | { ok: false; reason: 'not-public' | 'no-pass' | 'bad-pass' | 'taken' };

/**
 * 尝试通过「放映通道」进入公共房间。
 *
 * @param requirePassword 管理员传 false（免密且不消耗密码）
 *
 * 成功时的副作用：
 *   - 非管理员：**立即把 screeningPassword 置 null**（一次性密码，用过即废），
 *     并写入放映人记录（如果原本已有一条已过期的记录，会先清理再写）。
 *   - 管理员：不改动密码与放映人记录（他只是进来看看/接管）。
 */
export async function claimScreening(
  roomId: string,
  userId: string,
  password: unknown,
  isAdmin: boolean
): Promise<ClaimResult> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: {
      id: true,
      password: true,
      screeningPassword: true,
      host: { select: { isAdmin: true } }
    }
  });
  if (!room) return { ok: false, reason: 'not-public' };
  if (room.host?.isAdmin !== true) return { ok: false, reason: 'not-public' };

  // 管理员：免密直达，不消耗密码、不占放映位
  if (isAdmin) return { ok: true, asAdmin: true };

  const active = await getActiveScreeningHost(roomId);

  // 「本人再次进入」必须**最先**判定，且不需要密码：
  // 放映人刷新页面 / 暂离后再点放映通道（或前端在编辑弹窗后重新校验）时，
  // 一次性密码早已作废，若先走密码分支就会被自己的旧记录挡在门外 ——
  // 等于「一刷新就永久失去放映权限」，与 3 分钟宽限的设计直接冲突。
  // 这里同时恢复在线状态（清掉 graceUntil）。
  if (active === userId) {
    await prisma.roomScreeningHost.update({
      where: { roomId },
      data: { graceUntil: null }
    });
    return { ok: true, asAdmin: false };
  }

  // 判定顺序很重要：密码不存在必须优先于「已有人在放映」。
  // 否则一次性密码被前一个人用掉后，后来者会收到「已有放映人」这种误导性提示，
  // 而真实情况是「通道已关闭，需要管理员重新设密码」——两者给用户的下一步动作完全不同。
  if (!room.screeningPassword) {
    return { ok: false, reason: 'no-pass' };
  }

  // 已有其他有效放映人 → 不能抢占（此时密码仍在，说明管理员刚又设了新的）
  if (active) return { ok: false, reason: 'taken' };

  // 比对密码（与房间普通密码一样是明文比对；两者互相独立）
  const input = typeof password === 'string' ? password : '';
  if (input !== room.screeningPassword) return { ok: false, reason: 'bad-pass' };

  // 事务：作废一次性密码 + 登记放映人，避免并发下两个人同时通过
  await prisma.$transaction(async (tx) => {
    // 条件更新：只有密码仍是刚才那一个时才作废，防并发重复消费
    const consumed = await tx.room.updateMany({
      where: { id: roomId, screeningPassword: room.screeningPassword },
      data: { screeningPassword: null, screeningUpdatedAt: new Date() }
    });
    if (consumed.count !== 1) {
      const err: any = new Error('SCREENING_PASS_RACE');
      err.appCode = 'SCREENING_PASS_RACE';
      throw err;
    }
    await tx.roomScreeningHost.upsert({
      where: { roomId },
      create: { roomId, userId },
      update: { userId, claimedAt: new Date(), graceUntil: null }
    });
  });

  return { ok: true, asAdmin: false };
}

/**
 * 放映人掉线：**不删除记录**，只写入宽限截止时间，让他能在 3 分钟内连回来。
 * 若该用户本来就不是当前放映人，则什么都不做。
 */
export async function markScreeningGrace(roomId: string, userId: string): Promise<void> {
  try {
    const active = await getActiveScreeningHost(roomId);
    if (active !== userId) return;
    await prisma.roomScreeningHost.update({
      where: { roomId },
      data: { graceUntil: new Date(Date.now() + SCREENING_GRACE_MS) }
    });
  } catch {
    /* 记录可能已被清理，忽略 */
  }
}

/**
 * 彻底释放放映位。
 *
 * @param consumePass true 表示「本场结束」：连同放映密码一起保持已作废状态，
 *                    通道回到「未设密码」，需管理员重新设密码（需求规定的行为）。
 *                    传 false 时同样置空密码 —— 因为密码本就是一次性的，
 *                    一旦有人用过就不该再存在。
 */
export async function releaseScreening(roomId: string): Promise<void> {
  try {
    await prisma.roomScreeningHost.deleteMany({ where: { roomId } });
    await prisma.room.update({
      where: { id: roomId },
      data: {
        screeningPassword: null,
        screeningUpdatedAt: new Date(),
        status: 'WAITING',
        // 【新需求】本场结束 → 同时复位「本场是否已编辑过房间信息」，
        // 让下一场的第一位放映人重新获得一次编辑机会（每人每场一次）。
        roomEditedAt: null,
      }
    }).catch(() => {});
  } catch (error) {
    console.error(`释放放映位失败（roomId=${roomId}）:`, error);
  }
}

/**
 * 【新需求】当前这位放映人本场是否已经编辑过房间信息。
 *
 * 判定方式：房间的 roomEditedAt 是否晚于该放映人的 claimedAt —— 即「他上台之后有人改过」。
 * 由于放映位释放时会清空 roomEditedAt，且新放映人 upsert 时会刷新 claimedAt，
 * 这个比较天然做到「每人每场一次」，无需额外字段。
 */
export async function hasEditedThisSession(roomId: string, userId: string): Promise<boolean> {
  const row = await prisma.roomScreeningHost.findUnique({
    where: { roomId },
    select: { userId: true, claimedAt: true }
  });
  if (!row || row.userId !== userId) return false;
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { roomEditedAt: true }
  });
  if (!room?.roomEditedAt) return false;
  return room.roomEditedAt.getTime() >= row.claimedAt.getTime();
}

/** 【新需求】记录一次「放映人修改了房间信息」 */
export async function markRoomEdited(roomId: string): Promise<void> {
  await prisma.room.update({
    where: { id: roomId },
    data: { roomEditedAt: new Date() }
  }).catch(() => {});
}

/**
 * 清理所有宽限期已过的放映位（服务启动时 + 定时调用）。
 *
 * 这样即使没有人在临界点触发判定，通道也会自动回到「未设密码」状态，
 * 后台列表不会一直显示一个早已失效的「放映中」。
 */
export async function reapScreeningHosts(): Promise<number> {
  try {
    const expired = await prisma.roomScreeningHost.findMany({
      where: { graceUntil: { not: null, lte: new Date() } },
      select: { roomId: true }
    });
    for (const row of expired) {
      await releaseScreening(row.roomId);
    }
    return expired.length;
  } catch (error) {
    console.error('清理过期放映位失败:', error);
    return 0;
  }
}
