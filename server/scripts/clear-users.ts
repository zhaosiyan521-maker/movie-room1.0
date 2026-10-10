/**
 * 一次性清理脚本：删除所有普通用户及其关联数据，保留管理员账号，
 * 并解除管理员账号的封禁状态（配合白名单改造）。
 *
 * 该脚本：
 *  1. 解除所有管理员的 banned / banReason / bannedAt / abruptLeaves 状态
 *  2. 删除所有非管理员用户的关联数据（房间成员、房间黑名单、其开设的房间）
 *  3. 删除所有非管理员用户
 *  4. 清理孤儿图片文件（不再被任何房间引用的 uploads 图片）
 *  5. 清理封禁 IP 表（全部清空，配合"管理员白名单"语义，且测试数据无用）
 *  6. 清理已用邮箱令牌
 *
 * 用法：cd server && DATABASE_URL="file:./dev.db" npx ts-node scripts/clear-users.ts
 */
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

async function main() {
  console.log('🗑️  开始清理普通用户数据（保留管理员）...\n');

  // 1. 解除所有管理员的封禁状态（白名单保护 + 清除历史误封）
  const admins = await prisma.user.findMany({ where: { isAdmin: true }, select: { id: true, username: true, banned: true } });
  for (const a of admins) {
    await prisma.user.update({
      where: { id: a.id },
      data: { banned: false, banReason: null, bannedAt: null, abruptLeaves: 0 }
    });
    console.log(`  ✅ 已解除管理员「${a.username}」的封禁状态`);
  }

  // 2. 收集普通用户 ID
  const normalUsers = await prisma.user.findMany({ where: { isAdmin: false }, select: { id: true, username: true } });
  const normalIds = normalUsers.map(u => u.id);
  console.log(`\n  待删除普通用户：${normalUsers.length} 人`);

  // 3. 删除普通用户开设的房间（先收集图片用于后续清理）
  const hostedRooms = await prisma.room.findMany({
    where: { hostId: { in: normalIds } },
    select: { id: true, images: true }
  });
  const hostedRoomIds = hostedRooms.map(r => r.id);

  if (hostedRoomIds.length > 0) {
    await prisma.roomMember.deleteMany({ where: { roomId: { in: hostedRoomIds } } });
    await prisma.roomBan.deleteMany({ where: { roomId: { in: hostedRoomIds } } });
    await prisma.room.deleteMany({ where: { id: { in: hostedRoomIds } } });
    console.log(`  已删除普通用户开设的房间：${hostedRoomIds.length} 个`);
  }

  // 4. 删除普通用户作为成员的记录、被房间封禁的记录
  const memberDel = await prisma.roomMember.deleteMany({ where: { userId: { in: normalIds } } });
  const banDel = await prisma.roomBan.deleteMany({ where: { userId: { in: normalIds } } });
  console.log(`  已删除成员记录：${memberDel.count} 条，黑名单记录：${banDel.count} 条`);

  // 5. 删除普通用户本身
  const userDel = await prisma.user.deleteMany({ where: { id: { in: normalIds } } });
  console.log(`  已删除普通用户：${userDel.count} 人`);

  // 6. 清理封禁 IP 与已用令牌（全部清空，测试数据无用）
  const ipDel = await prisma.bannedIp.deleteMany({});
  const tokenDel = await prisma.usedToken.deleteMany({});
  console.log(`  已清理封禁 IP：${ipDel.count} 条，已用令牌：${tokenDel.count} 条`);

  // 7. 清理孤儿图片文件（不再被任何房间引用的 uploads 图片）
  const remainingRooms = await prisma.room.findMany({ select: { images: true } });
  const referenced = new Set<string>();
  for (const r of remainingRooms) {
    if (!r.images) continue;
    try {
      const arr = JSON.parse(r.images);
      if (Array.isArray(arr)) {
        for (const p of arr) {
          if (typeof p === 'string') {
            const m = /\/uploads\/([a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|gif))$/.exec(p);
            if (m) referenced.add(m[1]);
          }
        }
      }
    } catch { /* ignore */ }
  }

  let removedImgs = 0;
  if (fs.existsSync(UPLOAD_DIR)) {
    for (const fn of fs.readdirSync(UPLOAD_DIR)) {
      if (referenced.has(fn)) continue;
      const abs = path.join(UPLOAD_DIR, fn);
      try { fs.unlinkSync(abs); removedImgs++; } catch { /* ignore */ }
    }
  }
  console.log(`  已清理孤儿图片：${removedImgs} 张`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ 清理完成！');
  const remainAdmins = await prisma.user.findMany({ where: { isAdmin: true }, select: { username: true, banned: true } });
  const remainUsers = await prisma.user.count();
  console.log(`  剩余用户总数：${remainUsers} 人`);
  remainAdmins.forEach(a => console.log(`  · 管理员「${a.username}」 banned=${a.banned}`));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('❌ 清理失败:', e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
