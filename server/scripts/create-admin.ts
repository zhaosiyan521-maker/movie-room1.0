/**
 * 创建 / 提升管理员账号（非破坏性，不清空任何数据）。
 *
 * 用法：
 *   ADMIN_PASSWORD="你的强密码" npx ts-node scripts/create-admin.ts
 *
 * 可选环境变量：
 *   ADMIN_USERNAME  管理员用户名（默认 admin）
 *   ADMIN_EMAIL     管理员邮箱（默认 admin@movieroom.local）
 *
 * 行为：
 *   - 若该用户名/邮箱的账号已存在：提升为管理员，并同时重置其密码
 *   - 若不存在：新建一个管理员账号
 *
 * 与 reset-admin.ts 的区别：
 *   reset-admin.ts 会删除全部用户/房间/封禁数据，仅适合首次初始化；
 *   本脚本不动任何现有数据，适合云服务器重新部署后补建管理员。
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import * as readline from 'readline';

const prisma = new PrismaClient();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@movieroom.local';
const ADMIN_NICKNAME = '管理员';
const MIN_PASSWORD_LEN = 12;

async function resolveAdminPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv && fromEnv.length > 0) {
    if (fromEnv.length < MIN_PASSWORD_LEN) {
      throw new Error(`管理员密码强度不足：至少需要 ${MIN_PASSWORD_LEN} 位，当前 ${fromEnv.length} 位`);
    }
    return fromEnv;
  }

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
    const pwd = await ask(`请输入管理员密码（至少 ${MIN_PASSWORD_LEN} 位，输入不回显）：`);
    rl.close();
    if (!pwd || pwd.length < MIN_PASSWORD_LEN) {
      throw new Error(`密码强度不足：至少需要 ${MIN_PASSWORD_LEN} 位。已中止。`);
    }
    return pwd;
  }

  throw new Error(
    '未设置 ADMIN_PASSWORD 且为非交互环境。\n' +
    '用法：ADMIN_PASSWORD="你的强密码" npx ts-node scripts/create-admin.ts'
  );
}

async function main() {
  const password = await resolveAdminPassword();
  const passwordHash = await bcrypt.hash(password, 10);

  // 优先按用户名找，其次按邮箱找
  const existing =
    (await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } })) ||
    (await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } }));

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        isAdmin: true,
        passwordHash,
        banned: false,
        // 重置密码后使旧令牌全部失效
        tokenVersion: { increment: 1 },
      },
    });
    console.log(`✅ 已将现有账号「${existing.username}」提升为管理员，并重置了密码。`);
  } else {
    const admin = await prisma.user.create({
      data: {
        username: ADMIN_USERNAME,
        email: ADMIN_EMAIL,
        passwordHash,
        nickname: ADMIN_NICKNAME,
        isAdmin: true,
      },
    });
    console.log(`✅ 已创建管理员账号「${admin.username}」（邮箱 ${admin.email}）。`);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  用上面的用户名 + 你设置的密码登录，');
  console.log('  登录后点击导航栏「🛡️ 管理后台」即可进入管理员页面。');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('❌ 失败:', e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
