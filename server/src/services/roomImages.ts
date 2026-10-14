/**
 * 房间图片文件的统一清理工具。
 *
 * 背景（M5 修复）：上传图片的删除逻辑此前散落在三个地方，且行为不一致 ——
 *   - `routes/room.ts` 的 deleteOrphanImages：有跨房间引用检查；
 *   - `routes/admin.ts` 的 purgeRoomImages：有跨房间引用检查；
 *   - `services/roomDissolve.ts` 的 purgeRoomImages：**没有**跨房间引用检查。
 * 由于房间详情/列表接口会把 `images` 路径下发给所有登录用户，攻击者可以把他人房间的
 * `/uploads/<uuid>.png` 填进自己房间（`resolveUploadPath` 只校验文件存在、不校验归属），
 * 再解散自己房间，就会把他人的封面从磁盘删除。三处逻辑必须共用同一份实现，避免再次漂移。
 */
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';

export const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

/** 合法上传文件名的严格白名单（uuid + 扩展名），同时杜绝路径穿越 */
const IMG_NAME_RE = /^[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|gif)$/;

/**
 * 从 `/uploads/xxx.png` 形式的引用中取出安全文件名；不合法返回 null。
 * 双重校验：正则白名单 + 解析后必须仍位于 UPLOAD_DIR 内。
 */
export function safeUploadFilename(ref: unknown): string | null {
  if (typeof ref !== 'string' || !ref.startsWith('/uploads/')) return null;
  const filename = ref.slice('/uploads/'.length);
  if (!IMG_NAME_RE.test(filename)) return null;
  const abs = path.join(UPLOAD_DIR, filename);
  const rel = path.relative(UPLOAD_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return filename;
}

/**
 * 该文件是否仍被**其他**房间引用。
 *
 * 用 SQL 的 `contains` 做子串匹配（无法对 JSON 数组做精确成员判断），
 * 因此额外要求文件名长度 ≥ 20 —— 上传文件名是 uuid（36 字符）+ 扩展名，
 * 而 roomId 也是 uuid，长度门槛可以避免「某房间的 id 恰好出现在另一个房间的
 * images 文本里」这类极小概率的误判，同时不影响真实的文件引用匹配。
 */
async function isReferencedByOtherRoom(filename: string, excludeRoomId?: string): Promise<boolean> {
  if (filename.length < 20) return true; // 可疑输入一律按「被引用」保守处理
  try {
    const others = await prisma.room.findMany({
      where: {
        images: { contains: filename },
        ...(excludeRoomId ? { id: { not: excludeRoomId } } : {}),
      },
      select: { id: true },
    });
    return others.length > 0;
  } catch (error) {
    // 查询失败时保守处理：不删除，避免误伤他人图片
    console.error('检查图片引用失败（本次跳过删除）:', error);
    return true;
  }
}

/** 删除单个上传文件（已确认无其他引用）。文件不存在或删除失败都只记日志。 */
export function removeUploadFile(filename: string): void {
  const abs = path.join(UPLOAD_DIR, filename);
  const rel = path.relative(UPLOAD_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (error) {
    console.error(`删除上传文件失败: ${filename}`, error);
  }
}

/**
 * 删除一组不再被引用的图片文件（带跨房间引用检查）。
 *
 * @param refs           待检查的 `/uploads/...` 引用列表
 * @param keepRefs       本次仍要保留的引用（例如更新后新的图片列表）
 * @param excludeRoomId  正在处理的房间 id，检查引用时排除它自己
 */
export async function deleteUnreferencedImages(
  refs: string[],
  keepRefs: string[] = [],
  excludeRoomId?: string
): Promise<void> {
  const keep = new Set(keepRefs);
  for (const ref of refs) {
    if (keep.has(ref)) continue;
    const filename = safeUploadFilename(ref);
    if (!filename) continue;
    if (await isReferencedByOtherRoom(filename, excludeRoomId)) continue;
    removeUploadFile(filename);
  }
}
