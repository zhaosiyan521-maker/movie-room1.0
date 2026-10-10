import dotenv from 'dotenv';
dotenv.config();

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error('❌ 未配置 JWT_SECRET，请在 server/.env 中设置一个强随机密钥（例如 `openssl rand -hex 32`）');
}

// 拒绝明显的弱密钥 / 示例密钥。
// .env.example 中不再内置固定密钥（避免所有新装实例共用同一密钥），
// 但历史遗留或手工复制粘贴的情况仍需拦截。
const WEAK_SECRETS = new Set([
  '174a4264843fd826c7318ed9861fc75f00de14cf4922062d9e4ce3435972f142',
  'secret', 'changeme', 'test', 'jwt-secret', 'your-secret-key',
]);
if (jwtSecret.length < 32) {
  throw new Error('❌ JWT_SECRET 过短，请使用至少 32 位随机密钥（例如 `openssl rand -hex 32`）');
}
if (WEAK_SECRETS.has(jwtSecret.trim()) || WEAK_SECRETS.has(jwtSecret.trim().toLowerCase())) {
  throw new Error('❌ 检测到 JWT_SECRET 使用了示例/弱密钥，请重新生成：`openssl rand -hex 32`');
}

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  jwtSecret,
  databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',

  // 平台完全免费，无任何付费 / 支付功能

  // 管理员用户名列表。
  // 注意：仅用于 reset-admin.ts 等离线脚本创建管理员；
  // 注册接口不再依据用户名自动授予管理员（否则任何人都可抢注 admin 提权）。
  adminUsernames: (process.env.ADMIN_USERNAMES || 'admin').split(',').map(s => s.trim()).filter(Boolean),

  // 放映中强行中断达到该次数将永久封禁
  maxAbruptLeaves: 3,

  // 前端地址（用于 CORS 与拼接邮箱验证链接），支持逗号分隔的多个来源
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',

  // 对外公开的站点地址：专门用于拼接邮箱验证链接等对外 URL。
  // 优先取 PUBLIC_URL；未配置时取 CLIENT_URL 的第一个值。
  // 注意：不能用整个 CLIENT_URL（逗号分隔列表），否则生成的链接是坏的。
  publicUrl: (
    process.env.PUBLIC_URL ||
    (process.env.CLIENT_URL || 'http://localhost:3001').split(',')[0]
  ).trim().replace(/\/+$/, ''),

  // 允许的跨域来源列表
  allowedOrigins: (process.env.CLIENT_URL || 'http://localhost:5173')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // 服务监听地址：默认仅本机回环，避免暴露到局域网/公网。
  // 如需局域网共享观影，显式设置 HOST=0.0.0.0 并同步配置 CLIENT_URL 白名单。
  host: process.env.HOST || '127.0.0.1',

  // 邮件（SMTP）：留空则仅在服务端控制台打印验证链接，方便本地联调
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },

  // 各类令牌时效（秒）
  emailVerifyTtlSec: 30 * 60,   // 邮箱验证链接 30 分钟有效
  captchaTtlSec: 5 * 60,        // 滑块验证票据 5 分钟有效
  captchaValidSec: 5 * 60,      // 滑块挑战本身 5 分钟有效
};
