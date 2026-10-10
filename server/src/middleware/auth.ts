import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index';
import { prisma } from '../config/database';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    email: string;
    isAdmin: boolean;
  };
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '未提供认证令牌' });
    }

    const token = authHeader.split(' ')[1];

    // 验证 JWT（固定算法，防止 alg 降级攻击）
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as { userId: string; tv?: number };

    // 查询用户
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, username: true, email: true, isAdmin: true, banned: true, banReason: true, tokenVersion: true }
    });

    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }

    // 令牌版本校验：改密 / 封禁时 tokenVersion 自增，使旧 JWT 立即失效。
    // 否则账号被盗后即便改了密码，攻击者的旧令牌在有效期内依然可用。
    if ((decoded.tv ?? 0) !== user.tokenVersion) {
      return res.status(401).json({ error: '令牌已失效，请重新登录' });
    }

    // 封禁拦截：管理员（白名单）不受封禁制约，永远放行。
    // 这样即便管理员账号被误标为 banned，也能正常登录继续使用。
    if (user.banned && !user.isAdmin) {
      return res.status(403).json({ error: `你的账号已被永久封禁${user.banReason ? `：${user.banReason}` : ''}` });
    }

    req.user = { id: user.id, username: user.username, email: user.email, isAdmin: user.isAdmin };
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: '令牌已过期' });
    }
    return res.status(401).json({ error: '无效的令牌' });
  }
}

// 管理员权限中间件
export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

// 可选认证（不强制要求登录）
export async function optionalAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as { userId: string; tv?: number };

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, username: true, email: true, isAdmin: true, tokenVersion: true }
      });

      // 同样校验令牌版本，避免旧令牌继续访问可选认证接口
      if (user && (decoded.tv ?? 0) === user.tokenVersion) {
        req.user = {
          id: user.id,
          username: user.username,
          email: user.email,
          isAdmin: user.isAdmin,
        };
      }
    }

    next();
  } catch {
    // 忽略错误，继续作为未登录用户访问
    next();
  }
}
