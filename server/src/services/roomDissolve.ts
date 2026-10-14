/**
 * 房间解散服务：彻底删除房间及其全部关联数据，服务器端不保留任何历史记录。
 *
 * 需求：播放已结束的房间，房主退出后自动解散并清除——包括房间记录、
 * 成员记录、本场黑名单、房间图片文件，全部一并删除。
 */
import type { Server } from 'socket.io';
import { prisma } from '../config/database';
import { deleteUnreferencedImages } from './roomImages';

/**
 * 彻底解散并删除一个房间。
 * @param roomId 房间 ID
 * @param opts.io 可选：socket.io 实例，传入则向房间内所有用户广播 room-dissolved 并将其请出房间
 * @param opts.reason 广播给用户的原因文案
 * @returns 是否实际删除了房间（房间不存在时返回 false）
 */
export async function dissolveRoom(
  roomId: string,
  opts: { io?: Server | null; reason?: string } = {}
): Promise<boolean> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, images: true }
  });
  if (!room) return false;

  // 2. 删除数据库记录（先删子表再删主表）
  await prisma.roomMember.deleteMany({ where: { roomId } });
  await prisma.roomBan.deleteMany({ where: { roomId } });
  await prisma.room.delete({ where: { id: roomId } });

  // 1'. 【M5 修复】房间记录删除**之后**再清理图片文件，并带上跨房间引用检查。
  //     原实现在删除房间前直接 unlink，既没有检查其他房间是否仍引用同一张图
  //     （上传接口允许把已存在的 /uploads/xxx.png 直接引用进自己的房间），
  //     也没有复用 routes/room.ts、routes/admin.ts 已有的引用检查逻辑，
  //     导致「解散自己的房间 → 删掉他人的封面」。
  //     改为删除房间行之后再判断，此时本次引用已随记录消失，剩下的命中一定是他人引用。
  try {
    const arr = room.images ? JSON.parse(room.images) : [];
    if (Array.isArray(arr)) {
      await deleteUnreferencedImages(arr.filter((p): p is string => typeof p === 'string'), []);
    }
  } catch (error) {
    console.error('清理房间图片失败（房间已删除）:', error);
  }

  // 3. 通知房间内所有用户并请出房间
  if (opts.io) {
    opts.io.to(roomId).emit('room-dissolved', {
      roomId,
      reason: opts.reason || '房主已退出，房间自动解散并清除'
    });
    try { opts.io.in(roomId).socketsLeave(roomId); } catch { /* ignore */ }
  }

  // 4. 清理信令层内存状态（socketsLeave 只移除适配器房间，roomUsers/userRooms/播放缓存等会残留）
  //    动态引入避免与 signaling 形成静态循环依赖（signaling 已静态引入本模块）
  try {
    const { purgeRoomSignalingState } = await import('./signaling');
    purgeRoomSignalingState(roomId);
  } catch { /* ignore */ }

  return true;
}
