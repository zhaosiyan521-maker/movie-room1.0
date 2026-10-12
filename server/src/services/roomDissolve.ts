/**
 * 房间解散服务：彻底删除房间及其全部关联数据，服务器端不保留任何历史记录。
 *
 * 需求：播放已结束的房间，房主退出后自动解散并清除——包括房间记录、
 * 成员记录、本场黑名单、房间图片文件，全部一并删除。
 */
import fs from 'fs';
import path from 'path';
import type { Server } from 'socket.io';
import { prisma } from '../config/database';

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const IMG_NAME_RE = /^\/uploads\/([a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|gif))$/;

/** 删除房间图片文件（忽略不存在的文件） */
function purgeRoomImages(imagesJson: string | null): void {
  if (!imagesJson) return;
  try {
    const arr = JSON.parse(imagesJson);
    if (!Array.isArray(arr)) return;
    for (const p of arr) {
      if (typeof p !== 'string') continue;
      const m = IMG_NAME_RE.exec(p);
      if (!m) continue;
      // 双重校验：解析后必须仍位于 uploads 目录内，防止路径穿越
      const abs = path.join(UPLOAD_DIR, path.basename(m[1]));
      if (!abs.startsWith(UPLOAD_DIR)) continue;
      try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* ignore */ }
    }
  } catch { /* images 不是合法 JSON，忽略 */ }
}

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

  // 1. 删除图片文件（先于数据库删除，需要 images 字段内容）
  purgeRoomImages(room.images);

  // 2. 删除数据库记录（先删子表再删主表）
  await prisma.roomMember.deleteMany({ where: { roomId } });
  await prisma.roomBan.deleteMany({ where: { roomId } });
  await prisma.room.delete({ where: { id: roomId } });

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
