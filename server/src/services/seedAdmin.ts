import { prisma } from '../config/database';
import bcrypt from 'bcryptjs';

/**
 * 首次启动时按需创建初始管理员账号。
 *
 * 安全策略（重要变更）：**不再内置任何默认口令**。
 *   - 未设置 `ADMIN_PASSWORD`（或为空）→ **不创建任何管理员**，仅打印创建指引。
 *     旧实现会在空库上自动创建 `admin/admin`，任何拿到服务地址的人都能立刻
 *     取得最高权限（可封禁用户、解散任意房间、注销用户、发布公告与广播）——
 *     这在公网部署下等于把后台完全敞开，且与 README「管理员只能通过脚本创建」直接矛盾。
 *   - 设置了但短于 MIN_ADMIN_PASSWORD_LEN → 拒绝创建并说明原因（避免弱口令）。
 *   - 设置合规强密码 → 创建 `ADMIN_USERNAME`（默认 admin）。
 *   - 同名账号已存在 → 直接跳过，**绝不覆盖**管理员已改过的密码。
 *
 * 生产环境推荐做法：首次部署时配置一次 `ADMIN_PASSWORD`，创建完成后清空该变量；
 * 或直接使用离线脚本 `scripts/reset-admin.ts` / `scripts/create-admin.ts`。
 */
const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@movieroom.local';
const MIN_ADMIN_PASSWORD_LEN = 12;

/** 启动日志中的统一指引文案（未创建管理员时打印，便于运维照做） */
function printInitGuide(reason: string): void {
  console.warn(
    [
      '',
      '────────────────────────────────────────────────────────────',
      `ℹ️  ${reason}`,
      '   当前未创建管理员账号，管理后台不可用（这是安全的默认行为）。',
      '   如需管理员，请二选一：',
      '     A) 在 server/.env 中设置 ADMIN_USERNAME / ADMIN_PASSWORD（≥12 位强密码）后重启服务',
      '     B) 运行离线脚本手动创建（注意：reset-admin.ts 会清空所有数据）',
      '        cd server && ADMIN_PASSWORD="你的强密码" npx ts-node scripts/reset-admin.ts',
      '     C) 为已有账号提权（不删数据）：',
      '        cd server && npx ts-node scripts/create-admin.ts',
      '   创建完成后建议清空 .env 中的 ADMIN_PASSWORD，避免密码长期留在配置文件里。',
      '────────────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );
}

export async function ensureSeedAdmin(): Promise<void> {
  try {
    const existing = await prisma.user.findUnique({ where: { username: DEFAULT_ADMIN_USERNAME } });
    if (existing) {
      // 已存在同名账号（可能是管理员或普通用户），不覆盖其密码，仅提示
      if (!existing.isAdmin) {
        console.warn(
          `⚠️  检测到用户名 "${DEFAULT_ADMIN_USERNAME}" 已存在但不是管理员，` +
          `如需将其设为管理员请运行：cd server && npx ts-node scripts/create-admin.ts`
        );
      }
      return;
    }

    const rawPassword = (process.env.ADMIN_PASSWORD || '').trim();

    // 未配置密码：不创建任何管理员（安全默认），只给出指引
    if (!rawPassword) {
      printInitGuide('未配置 ADMIN_PASSWORD，已跳过管理员创建。');
      return;
    }

    // 配置了但不够强：拒绝创建，避免把弱口令管理员暴露到公网
    if (rawPassword.length < MIN_ADMIN_PASSWORD_LEN) {
      printInitGuide(
        `ADMIN_PASSWORD 长度不足 ${MIN_ADMIN_PASSWORD_LEN} 位，已拒绝创建管理员！`
      );
      return;
    }

    const passwordHash = await bcrypt.hash(rawPassword, 10);
    await prisma.user.create({
      data: {
        username: DEFAULT_ADMIN_USERNAME,
        email: DEFAULT_ADMIN_EMAIL,
        passwordHash,
        nickname: '管理员',
        isAdmin: true,
      },
    });

    console.log(
      `✅ 已创建初始管理员账号：${DEFAULT_ADMIN_USERNAME}\n` +
      `   建议：确认可以登录后，清空 server/.env 中的 ADMIN_PASSWORD。`
    );
  } catch (err) {
    // 播种失败不应阻断服务启动（例如数据库未就绪时），仅记录错误
    console.error('初始化管理员账号失败（服务继续启动）：', err);
  }
}
