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
  if (windows.size > MAX_KEYS) windows.clear();
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
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}
