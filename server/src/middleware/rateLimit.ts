import { Request, Response, NextFunction } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Bucket>();

// 内存上限：超过即清空，防止攻击者用大量伪造 IP 把 Map 撑爆
const MAX_KEYS = 50_000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * 清理已过期的桶。
 * 若不做清理，每个新 IP 都会永久占用一个 key（桶只在同 key 再次命中时被替换），
 * 长期运行或被扫描时会造成内存持续增长。
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of windows) {
    if (now > b.resetAt) windows.delete(key);
  }
  if (windows.size > MAX_KEYS) {
    // 【S9】超限不能再整体 clear()。
    // 旧实现在 key 数超过 MAX_KEYS 时清空整个 Map，等于让所有 IP 同时获得限流豁免——
    // 攻击者只要持续用伪造 IP 把 Map 撑大并触发一次清空，就能反复重置他人的限流计数。
    // 改为按 LRU 顺序淘汰最旧的 key：Map 的迭代顺序即插入顺序，命中时会把 key 刷新到末尾，
    // 因此从头部开始删除淘汰的就是最久未被使用的记录。
    let overflow = windows.size - MAX_KEYS;
    for (const key of windows.keys()) {
      if (overflow <= 0) break;
      windows.delete(key);
      overflow -= 1;
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

/**
 * 极简内存级固定窗口限流（无需额外依赖）。
 * 以「客户端真实 IP + 路由路径」为键，避免登录/注册接口被暴力破解或刷接口。
 */
export function rateLimit(options: { windowMs: number; max: number; message?: string }) {
  const { windowMs, max, message = '请求过于频繁，请稍后再试' } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    // 真实 IP（trust proxy 已关闭，req.ip 即 socket 远端地址）
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    let bucket = windows.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      windows.set(key, bucket);
    } else {
      // 命中已存在的桶：把这个 key 重新插到 Map 末尾，维持 LRU 顺序，
      // 保证超限淘汰时删掉的是最久未被使用的 key（配合上面的淘汰逻辑）。
      windows.delete(key);
      windows.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}
