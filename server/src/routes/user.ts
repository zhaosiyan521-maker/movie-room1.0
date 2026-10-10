import express, { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { config } from '../config/index';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { verifyEmailToken, consumeEmailToken } from '../services/verifyLink';

export const userRouter = Router();

// 所有用户路由都需要认证
userRouter.use(authMiddleware);
// 解析 JSON 请求体（默认 100kb 上限）
userRouter.use(express.json());

const USERNAME_COOLDOWN_DAYS = 30;

// 获取用户信息
userRouter.get('/profile', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        username: true,
        email: true,
        nickname: true,
        avatar: true,
        isAdmin: true,
        usernameChangedAt: true,
        createdAt: true
      }
    });

    res.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: '获取用户信息失败' });
  }
});

// 更新用户信息（昵称 / 头像 / 用户名）
userRouter.patch('/profile', async (req: AuthRequest, res: Response) => {
  try {
    const { nickname, avatar, username } = req.body || {};

    const updateData: any = {};

    // 昵称：trim 后非空 + 长度上限，避免全空格昵称与超长昵称入库
    if (nickname !== undefined) {
      if (typeof nickname !== 'string') {
        return res.status(400).json({ error: '昵称格式无效' });
      }
      const trimmed = nickname.trim();
      if (!trimmed || trimmed.length > 30) {
        return res.status(400).json({ error: '昵称不能为空且不能超过 30 个字符' });
      }
      updateData.nickname = trimmed;
    }

    if (avatar !== undefined) {
      // 仅允许 http(s) 链接或 data:image 内嵌图，杜绝 javascript: 等危险 scheme
      if (
        typeof avatar === 'string' &&
        avatar.length <= 2000 &&
        /^(https?:\/\/|data:image\/)/i.test(avatar)
      ) {
        updateData.avatar = avatar;
      } else {
        return res.status(400).json({ error: '头像链接格式无效' });
      }
    }

    // 修改用户名：30 天冷却 + 全局唯一
    if (username && username !== req.user!.username) {
      if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        return res.status(400).json({ error: '用户名需为 3-20 位字母、数字或下划线' });
      }

      const current = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { usernameChangedAt: true }
      });

      if (current?.usernameChangedAt) {
        const nextAllowed = new Date(current.usernameChangedAt);
        nextAllowed.setDate(nextAllowed.getDate() + USERNAME_COOLDOWN_DAYS);
        if (nextAllowed > new Date()) {
          return res.status(400).json({
            error: `用户名每 ${USERNAME_COOLDOWN_DAYS} 天只能修改一次，下次可修改时间：${nextAllowed.toLocaleDateString('zh-CN')}`
          });
        }
      }

      const existing = await prisma.user.findUnique({ where: { username } });
      if (existing) {
        return res.status(409).json({ error: '该用户名已被使用，请换一个' });
      }

      updateData.username = username;
      updateData.usernameChangedAt = new Date();
    }

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: updateData,
      select: {
        id: true,
        username: true,
        email: true,
        nickname: true,
        avatar: true,
        isAdmin: true,
        usernameChangedAt: true
      }
    });

    res.json({ message: '更新成功', user });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: '更新用户信息失败' });
  }
});

// 修改密码
// 普通用户：必须凭邮箱验证链接令牌（emailVerifyToken）
// 管理员特权：可凭「邮箱验证链接」或「当前密码」二选一，无需邮箱验证
userRouter.post('/change-password', async (req: AuthRequest, res: Response) => {
  try {
    const { newPassword, emailVerifyToken, currentPassword } = req.body || {};
    const userId = req.user!.id;

    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: '新密码长度需为 8-128 位' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: '用户不存在' });

    let authorized = false;

    // 管理员：可用当前密码验证（免邮箱）
    if (user.isAdmin && typeof currentPassword === 'string') {
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      // 用 400 而非 401：这是表单校验错误，不是凭证失效。
      // 若用 401，客户端拦截器会把它当成登录态过期，直接把用户踢出登录页。
      if (!ok) return res.status(400).json({ error: '当前密码不正确' });
      authorized = true;
    }

    // 其余情况：必须凭邮箱验证链接令牌
    if (!authorized) {
      if (typeof emailVerifyToken !== 'string') {
        return res.status(400).json({ error: '请先通过邮箱验证链接完成验证' });
      }
      const verified = await verifyEmailToken(emailVerifyToken, 'change-password', user.email);
      if (!verified) {
        return res.status(400).json({ error: '邮箱验证无效或已过期，请重新获取验证链接' });
      }
      // 先原子消费再改密：避免并发请求用同一链接改密两次
      const consumed = await consumeEmailToken(emailVerifyToken);
      if (!consumed) {
        return res.status(400).json({ error: '邮箱验证链接已被使用，请重新获取' });
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      // tokenVersion 自增：使此前签发的所有 JWT 立即失效，
      // 否则账号被盗时即便改了密码，攻击者的旧令牌在 7 天内依然可用。
      data: { passwordHash, tokenVersion: { increment: 1 } }
    });

    res.json({ message: '密码修改成功，请重新登录' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: '修改密码失败，请稍后重试' });
  }
});

// 绑定邮箱（首次绑定 / 更换邮箱），必须凭邮箱验证链接令牌
userRouter.post('/bind-email', async (req: AuthRequest, res: Response) => {
  try {
    const { email: rawEmail, emailVerifyToken } = req.body || {};
    const userId = req.user!.id;

    if (typeof rawEmail !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail.trim())) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }
    const email = rawEmail.trim();
    if (typeof emailVerifyToken !== 'string') {
      return res.status(400).json({ error: '请先通过邮箱验证链接完成验证' });
    }

    const verified = await verifyEmailToken(emailVerifyToken, 'bind-email', email);
    if (!verified) {
      return res.status(400).json({ error: '邮箱验证无效或已过期，请重新获取验证链接' });
    }

    const taken = await prisma.user.findUnique({ where: { email } });
    if (taken && taken.id !== userId) {
      return res.status(409).json({ error: '该邮箱已被其他账号使用' });
    }

    // 先原子消费再改邮箱，避免并发用同一链接绑定
    const consumed = await consumeEmailToken(emailVerifyToken);
    if (!consumed) {
      return res.status(400).json({ error: '邮箱验证链接已被使用，请重新获取' });
    }

    await prisma.user.update({
      where: { id: userId },
      // 换绑邮箱同样使旧令牌失效
      data: { email, tokenVersion: { increment: 1 } }
    });

    res.json({ message: '邮箱绑定成功，请重新登录' });
  } catch (error) {
    console.error('Bind email error:', error);
    res.status(500).json({ error: '绑定邮箱失败，请稍后重试' });
  }
});

// 搜索用户（按用户名或昵称）
userRouter.get('/search', async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.json({ users: [] });
    }

    const users = await prisma.user.findMany({
      where: {
        banned: false,
        OR: [
          { username: { contains: q } },
          { nickname: { contains: q } }
        ]
      },
      select: {
        id: true,
        username: true,
        nickname: true,
        _count: {
          select: {
            rooms: {
              where: { status: { in: ['WAITING', 'PLAYING'] } }
            }
          }
        }
      },
      take: 10
    });

    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: '搜索用户失败' });
  }
});

// 获取指定用户开设的所有活跃房间
userRouter.get('/:id/rooms', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, username: true, nickname: true }
    });

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const rooms = await prisma.room.findMany({
      where: {
        hostId: user.id,
        status: { in: ['WAITING', 'PLAYING'] }
      },
      select: {
        id: true,
        name: true,
        description: true,
        images: true,
        status: true,
        maxViewers: true,
        currentMovie: true,
        createdAt: true,
        updatedAt: true,
        hostId: true,
        password: true, // 仅用于转 hasPassword，不下发原值
        host: { select: { id: true, username: true, nickname: true } },
        _count: { select: { members: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    const safeRooms = rooms.map(({ password, ...r }) => ({ ...r, hasPassword: Boolean(password) }));

    res.json({ user, rooms: safeRooms });
  } catch (error) {
    console.error('Get user rooms error:', error);
    res.status(500).json({ error: '获取用户房间失败' });
  }
});
