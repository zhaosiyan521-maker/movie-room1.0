/**
 * 清理语音实测留下的测试数据（房间 + 两个测试账号）。
 *
 * 为什么需要：服务端没有 DELETE /rooms/:id 路由，房主进程被杀后房间不会立即消失，
 * 而「每个 IP 同时可开设房间数」的限制会让下一次实测直接失败（配额被占用）。
 *
 * 用法（在服务器的应用目录下执行）：
 *   scp scripts/clean-voice-probe.js root@<服务器>:<APP_DIR>/clean-voice-probe.js
 *   cd <APP_DIR> && node clean-voice-probe.js            # 只清理房间
 *   cd <APP_DIR> && node clean-voice-probe.js --users    # 同时删除测试账号
 *
 * 环境变量（需与 mint-voice-tokens.js 一致，否则找不到账号）：
 *   PROBE_HOST_USER / PROBE_VIEWER_USER（默认 phvoice1 / pvvoice1）
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const USERS = [
  process.env.PROBE_HOST_USER || 'phvoice1',
  process.env.PROBE_VIEWER_USER || 'pvvoice1',
];

(async () => {
  const withUsers = process.argv.includes('--users');

  // 1) 删除测试账号名下的房间及其关联行
  const owners = await prisma.user.findMany({ where: { username: { in: USERS } }, select: { id: true, username: true } });
  for (const o of owners) {
    const rooms = await prisma.room.findMany({ where: { hostId: o.id }, select: { id: true, name: true } });
    for (const r of rooms) {
      await prisma.roomMember.deleteMany({ where: { roomId: r.id } });
      await prisma.roomBan.deleteMany({ where: { roomId: r.id } });
      await prisma.room.delete({ where: { id: r.id } });
      console.log(`deleted room ${r.name} (${r.id})`);
    }
    // 也清理这两个账号作为普通成员残留的成员行
    await prisma.roomMember.deleteMany({ where: { userId: o.id } });
    await prisma.roomBan.deleteMany({ where: { userId: o.id } });
  }
  if (!owners.length) console.log('no probe users found');

  if (withUsers) {
    await prisma.user.deleteMany({ where: { username: { in: USERS } } });
    await prisma.emailVerify.deleteMany({ where: { email: { in: USERS.map(u => u + '@probe.local') } } });
    console.log('deleted probe users');
  }

  await prisma.$disconnect();
  process.exit(0);
})().catch(e => { console.error('CLEAN_ERROR ' + e.message); process.exit(1); });
