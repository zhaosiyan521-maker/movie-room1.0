import { prisma } from '../config/database';
import bcrypt from 'bcryptjs';

/**
 * 首次启动时确保存在一个初始管理员账号。
 *
 * 行为：
 *   - 默认用户名 / 密码均为 `admin`（可通过环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 覆盖）。
 *   - 若已存在同名账号则直接跳过，绝不覆盖管理员已修改的密码。
 *   - 管理员登录后可在「个人中心」凭当前密码修改密码（保留原有改密方式）。
 *
 * 注意：初始密码 admin 仅为开箱即用默认值，已在启动日志中提示尽快修改。
 */
const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@movieroom.local';

export async function ensureSeedAdmin(): Promise<void> {
  try {
    const existing = await prisma.user.findUnique({ where: { username: DEFAULT_ADMIN_USERNAME } });
    if (existing) {
      // 已存在同名账号（可能是管理员或普通用户），不覆盖其密码，仅提示
      if (!existing.isAdmin) {
        console.warn(
          `⚠️  检测到用户名 "${DEFAULT_ADMIN_USERNAME}" 已存在但不是管理员，` +
          `如需将其设为管理员请运行：ADMIN_PASSWORD="强密码" npx ts-node scripts/create-admin.ts`
        );
      }
      return;
    }

    const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    await prisma.user.create({
      data: {
        username: DEFAULT_ADMIN_USERNAME,
        email: DEFAULT_ADMIN_EMAIL,
        passwordHash,
        nickname: '管理员',
        isAdmin: true,
      },
    });

    if (DEFAULT_ADMIN_PASSWORD === 'admin') {
      console.warn(
        '⚠️  已创建初始管理员账号，用户名/密码均为 admin。' +
        '请登录后在「个人中心」尽快修改密码！'
      );
    } else {
      console.log(`✅ 已创建初始管理员账号：${DEFAULT_ADMIN_USERNAME}`);
    }
  } catch (err) {
    // 播种失败不应阻断服务启动（例如数据库未就绪时），仅记录错误
    console.error('初始化管理员账号失败（服务继续启动）：', err);
  }
}
