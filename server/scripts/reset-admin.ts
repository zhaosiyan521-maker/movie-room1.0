/**
 * 一键重置脚本：清空所有用户数据（注册信息、房间、成员、黑名单、封禁 IP），
 * 并创建全新的管理员账号。
 * 用法：npx ts-node scripts/reset-admin.ts
 *
 * 管理员密码通过环境变量 ADMIN_PASSWORD 提供。
 * 出于安全考虑：不再回退到默认密码 —— 默认密码会让任何拿到脚本的人
 * 都可能创建出 admin/admin 账号。非交互环境未提供密码时直接退出。
 * 也可运行时交互输入（若未设置环境变量且处于 TTY）。
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import * as readline from 'readline';

const prisma = new PrismaClient();

const ADMIN_USERNAME = 'admin';
const ADMIN_EMAIL = 'admin@movieroom.local';
const ADMIN_NICKNAME = '管理员';
const MIN_PASSWORD_LEN = 12;

async function resolveAdminPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv && fromEnv.length > 0) {
    if (fromEnv.length < MIN_PASSWORD_LEN) {
      throw new Error(`管理员密码强度不足：至少需要 ${MIN_PASSWORD_LEN} 位。当前 ${fromEnv.length} 位。`);
    }
    return fromEnv;
  }

  // 无环境变量且为交互终端时，提示输入（输入内容不回显）
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const ask = (q: string) =>
      new Promise<string>((resolve) => rl.question(q, (a) => resolve(a)));
    const pwd = await ask(`请输入管理员密码（至少 ${MIN_PASSWORD_LEN} 位，输入不回显）：`);
    rl.close();
    if (!pwd || pwd.length < MIN_PASSWORD_LEN) {
      throw new Error(`密码强度不足：至少需要 ${MIN_PASSWORD_LEN} 位。已中止，未创建管理员账号。`);
    }
    return pwd;
  }

  // 非交互环境且无环境变量：直接中止，绝不使用默认密码
  throw new Error(
    '未设置 ADMIN_PASSWORD 且当前为非交互环境，已中止。\n' +
    '请使用强密码后重试，例如：\n' +
    '  PowerShell: $env:ADMIN_PASSWORD="你的强密码"; npx ts-node scripts/reset-admin.ts\n' +
    '  CMD:        set ADMIN_PASSWORD=你的强密码 && npx ts-node scripts/reset-admin.ts'
  );
}

async function main() {
  // 先解析密码，强度不足时在清空数据「之前」就中止，
  // 避免出现"数据已被清空但管理员没建成"的破坏性中间状态。
  const ADMIN_PASSWORD = await resolveAdminPassword();

  console.log('🗑️  开始清空数据库...');

  // 按外键依赖顺序删除所有数据
  const usedTokens = await prisma.usedToken.deleteMany({});
  const roomBans = await prisma.roomBan.deleteMany({});
  const roomMembers = await prisma.roomMember.deleteMany({});
  const rooms = await prisma.room.deleteMany({});
  const bannedIps = await prisma.bannedIp.deleteMany({});
  const users = await prisma.user.deleteMany({});

  console.log(`   已删除已用令牌:   ${usedTokens.count} 条`);
  console.log(`   已删除房间黑名单: ${roomBans.count} 条`);
  console.log(`   已删除房间成员:   ${roomMembers.count} 条`);
  console.log(`   已删除房间:       ${rooms.count} 个`);
  console.log(`   已删除封禁 IP:    ${bannedIps.count} 条`);
  console.log(`   已删除用户:       ${users.count} 个`);

  // 创建管理员账号
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const admin = await prisma.user.create({
    data: {
      username: ADMIN_USERNAME,
      email: ADMIN_EMAIL,
      passwordHash,
      nickname: ADMIN_NICKNAME,
      isAdmin: true,
    },
  });

  console.log('');
  console.log('✅ 数据库已重置完成！');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   管理员账号: ${admin.username}`);
  console.log(`   管理员密码: ${'*'.repeat(ADMIN_PASSWORD.length)}（已隐藏）`);
  console.log(`   管理员 ID:  ${admin.id}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('❌ 重置失败:', e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
