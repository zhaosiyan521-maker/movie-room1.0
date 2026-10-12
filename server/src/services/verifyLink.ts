import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { prisma } from '../config/database';

export type VerifyPurpose = 'register' | 'change-password' | 'bind-email';

/**
 * 已使用的一次性令牌 jti。
 *
 * 必须落库而非仅存内存：内存方案在服务重启后会让全部已消费令牌复活，
 * 攻击者即可重放历史令牌完成账号接管（改密码 / 绑邮箱）。
 *
 * 清理策略为「按时间戳精确淘汰」，绝不能整体 clear——
 * 整体清空会把所有已消费令牌一次性复活。
 */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

async function cleanupUsedJtis(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - config.emailVerifyTtlSec * 1000);
    await prisma.usedToken.deleteMany({ where: { usedAt: { lt: cutoff } } });
  } catch (error) {
    console.error('清理过期令牌失败:', error);
  }
}

setInterval(cleanupUsedJtis, CLEANUP_INTERVAL_MS).unref();

/** 签发邮箱验证令牌（自包含 email + purpose + 过期 + 一次性 jti） */
export function issueEmailToken(email: string, purpose: VerifyPurpose): string {
  const jti = uuidv4();
  return jwt.sign({ email, purpose, jti }, config.jwtSecret, {
    expiresIn: `${config.emailVerifyTtlSec}s`,
  });
}

async function isJtiUsed(jti: string): Promise<boolean> {
  try {
    const found = await prisma.usedToken.findUnique({ where: { jti } });
    return !!found;
  } catch (error) {
    // 数据库异常时保守处理：视为已使用，宁可拒绝也不放过重放
    console.error('查询令牌状态失败:', error);
    return true;
  }
}

/**
 * 校验邮箱验证令牌：签名/过期/purpose/邮箱一致性/一次性。
 * 成功返回 { email, purpose }，否则返回 null（不消耗，供 /verify-email 预览；
 * 真正消耗在后续动作接口调用 consumeEmailToken）。
 */
export async function verifyEmailToken(
  token: string,
  expectedPurpose: VerifyPurpose,
  expectedEmail?: string
): Promise<{ email: string; purpose: VerifyPurpose } | null> {
  if (typeof token !== 'string' || !token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as any;
    if (payload.type === 'captcha') return null; // 误用滑块令牌
    if (payload.purpose !== expectedPurpose) return null;
    if (expectedEmail && payload.email !== expectedEmail) return null;
    if (!payload.jti) return null;
    if (await isJtiUsed(payload.jti)) return null;
    return { email: payload.email, purpose: payload.purpose };
  } catch {
    return null;
  }
}

/**
 * 事务内的数据库客户端形态。
 *
 * 【S5】为了让「消费验证凭据」与「创建用户」处在同一个事务里（建号失败时凭据自动回滚），
 * consumeEmailToken / consumeEmailVerified 需要接受事务客户端 tx。
 * 这里只用最小结构接口描述所需能力，事务客户端与全局 prisma 都满足它，
 * 避免引入 Prisma.TransactionClient 带来的类型摩擦。
 */
interface TokenDb {
  usedToken: { create(args: { data: { jti: string } }): Promise<unknown> };
  emailVerify: {
    deleteMany(args: { where: { email: string; purpose: string } }): Promise<{ count: number }>;
  };
}

/**
 * 原子消费令牌：利用 jti 作为主键，插入冲突即说明已被使用。
 * 返回 true 表示本次消费成功（此前未被使用）。
 *
 * 注意：审计旧实现时在「必须早于副作用执行」与「建号失败要还回令牌」之间存在矛盾——
 * 单纯把调用顺序挪到 create 之后会重新引入 TOCTOU（并发请求可重复利用同一令牌），
 * 而先消费则在建号失败时白白浪费用户好不容易完成的邮箱验证。
 * 正解是把两者放进同一个事务：由 @param db 传入事务客户端即可实现原子性。
 */
export async function consumeEmailToken(token: string, db: TokenDb = prisma): Promise<boolean> {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as any;
    if (!payload.jti) return false;
    await db.usedToken.create({ data: { jti: payload.jti } });
    return true;
  } catch {
    // 唯一约束冲突 = 已被消费
    return false;
  }
}

/**
 * 通用校验令牌（不限定 purpose），用于 /verify-email 预览返回 email+purpose。
 * 仅检查签名/过期/一次性，不做 purpose/email 匹配。
 */
export async function inspectEmailToken(token: string): Promise<{ email: string; purpose: VerifyPurpose } | null> {
  if (typeof token !== 'string' || !token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as any;
    if (payload.type === 'captcha') return null;
    if (!payload.jti) return null;
    if (await isJtiUsed(payload.jti)) return null;
    if (typeof payload.email !== 'string' || typeof payload.purpose !== 'string') return null;
    return { email: payload.email, purpose: payload.purpose as VerifyPurpose };
  } catch {
    return null;
  }
}

/**
 * 标记某邮箱某用途「已完成验证」。
 * 在 /verify-email 确认 token 有效后调用，落库一份记录，
 * 供后续 register / change-password / bind-email 在本地 token 丢失时按邮箱兜底求证。
 */
export async function markEmailVerified(email: string, purpose: VerifyPurpose): Promise<void> {
  try {
    await prisma.emailVerify.upsert({
      where: { email_purpose: { email, purpose } },
      create: { email, purpose },
      update: { verifiedAt: new Date() }
    });
  } catch (error) {
    console.error('标记邮箱验证失败:', error);
  }
}

/**
 * 查询某邮箱某用途是否已完成验证（且仍在有效期内）。
 * 超过 emailVerifyTtlSec 的旧记录视为失效，避免过期验证被永久复用。
 */
export async function isEmailVerified(email: string, purpose: VerifyPurpose): Promise<boolean> {
  try {
    const rec = await prisma.emailVerify.findUnique({
      where: { email_purpose: { email, purpose } }
    });
    if (!rec) return false;
    const age = Date.now() - rec.verifiedAt.getTime();
    return age <= config.emailVerifyTtlSec * 1000;
  } catch (error) {
    console.error('查询邮箱验证状态失败:', error);
    return false;
  }
}

/**
 * 按邮箱消费一条已验证记录（注册成功后调用，避免同一份验证被重复用于多次注册）。
 * 返回是否成功消费（存在该记录）。
 */
export async function consumeEmailVerified(
  email: string,
  purpose: VerifyPurpose,
  db: TokenDb = prisma
): Promise<boolean> {
  try {
    const res = await db.emailVerify.deleteMany({
      where: { email, purpose }
    });
    return res.count > 0;
  } catch (error) {
    console.error('消费邮箱验证记录失败:', error);
    return false;
  }
}
