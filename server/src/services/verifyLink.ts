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
 * 原子消费令牌：利用 jti 作为主键，插入冲突即说明已被使用。
 * 返回 true 表示本次消费成功（此前未被使用）。
 *
 * 注意：必须在执行业务副作用「之前」调用，否则并发请求会同时通过
 * verifyEmailToken 检查（TOCTOU），使同一个链接被使用两次。
 */
export async function consumeEmailToken(token: string): Promise<boolean> {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as any;
    if (!payload.jti) return false;
    await prisma.usedToken.create({ data: { jti: payload.jti } });
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
