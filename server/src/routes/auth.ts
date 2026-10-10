import express, { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database';
import { config } from '../config/index';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { createChallenge, verifyCaptcha, isValidCaptchaToken } from '../services/captcha';
import {
  issueEmailToken,
  verifyEmailToken,
  inspectEmailToken,
  consumeEmailToken,
  VerifyPurpose
} from '../services/verifyLink';
import { sendVerificationLink, emailConfigured } from '../services/email';

export const authRouter = Router();

// 认证接口统一解析 JSON 请求体（默认 100kb 上限）
authRouter.use(express.json());

// 注册 / 登录限流：同一 IP 15 分钟内最多 10 次，缓解暴力破解与刷接口
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: '操作过于频繁，请 15 分钟后再试' });
// 发验证链接限流：同一 IP 15 分钟内最多 5 次
const sendLinkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: '验证链接请求过于频繁，请稍后再试' });
// 验证码接口限流：防止内存被挑战对象灌满（原本无限制，可被脚本化滥用）
const captchaLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: '验证请求过于频繁，请稍后再试' });

function clientIp(req: Request): string {
  // trust proxy 已关闭，直接取 socket 真实远端地址，忽略任何 X-Forwarded-For 头
  const ip = (req.socket && req.socket.remoteAddress) || req.ip || '';
  return ip.replace(/^::ffff:/, '');
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// 用户名规则：与修改用户名（user.ts）保持同一份，避免两处规则漂移
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MAX_PASSWORD_LEN = 128;
const MAX_NICKNAME_LEN = 30;
const PURPOSES: VerifyPurpose[] = ['register', 'change-password', 'bind-email'];

function normalizeEmail(email: string): string {
  return email.trim();
}

// ===== 滑块人机验证 =====
authRouter.post('/captcha/challenge', captchaLimiter, (req: Request, res: Response) => {
  // 仅返回挑战 id 与带缺口的底图，正确位置 gap 绝不外泄
  res.json(createChallenge());
});

authRouter.post('/captcha/verify', captchaLimiter, (req: Request, res: Response) => {
  const { id, pos } = req.body || {};
  if (typeof id !== 'string' || typeof pos !== 'number') {
    return res.status(400).json({ error: '参数无效' });
  }
  const token = verifyCaptcha(id, pos);
  if (!token) return res.status(400).json({ error: '验证未通过，请重新拖动滑块对齐' });
  res.json({ captchaToken: token });
});

// ===== 发送邮箱验证链接（必须先通过滑块） =====
authRouter.post('/send-verify-link', sendLinkLimiter, async (req: Request, res: Response) => {
  try {
    const { email: rawEmail, purpose, captchaToken } = req.body || {};
    if (!isValidCaptchaToken(captchaToken)) {
      return res.status(400).json({ error: '请先完成人机验证' });
    }
    if (typeof rawEmail !== 'string' || !EMAIL_RE.test(rawEmail.trim())) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }
    if (typeof purpose !== 'string' || !PURPOSES.includes(purpose as VerifyPurpose)) {
      return res.status(400).json({ error: '无效的操作类型' });
    }
    const email = normalizeEmail(rawEmail);

    // 不同用途对邮箱存在性的要求不同，避免泄露账号信息
    if (purpose === 'register' || purpose === 'bind-email') {
      const taken = await prisma.user.findUnique({ where: { email } });
      if (taken) return res.status(409).json({ error: '该邮箱已被其他账号使用' });
    } else if (purpose === 'change-password') {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return res.status(404).json({ error: '该邮箱未绑定任何账号' });
    }

    const token = issueEmailToken(email, purpose as VerifyPurpose);
    const link = `${config.publicUrl}/email-verify?t=${encodeURIComponent(token)}`;
    await sendVerificationLink(email, link, purpose);

    // 未配置真实 SMTP 时，把链接直接返回给前端，方便本地联调（链接同时也打印在控制台）
    const payload: { message: string; devLink?: string } = {
      message: emailConfigured
        ? '验证链接已发送，请前往邮箱点击完成验证'
        : '验证链接已生成（当前未配置邮件服务，请复制下方链接完成验证）'
    };
    if (!emailConfigured) payload.devLink = link;
    res.json(payload);
  } catch (error) {
    console.error('Send verify link error:', error);
    res.status(500).json({ error: '发送失败，请稍后重试' });
  }
});

// ===== 校验邮箱验证链接（前端点击链接后调用） =====
// 仅做预览，不消耗令牌（真正消耗在 register / bind-email / change-password）
authRouter.get('/verify-email', async (req: Request, res: Response) => {
  const t = req.query.t as string;
  const info = await inspectEmailToken(t);
  if (!info) return res.status(400).json({ error: '验证链接无效或已过期，请重新获取' });
  res.json({ ok: true, email: info.email, purpose: info.purpose });
});

// 用户注册（必须携带有效的邮箱验证令牌）
authRouter.post('/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username: rawName, email: rawEmail, password, nickname, emailVerifyToken } = req.body || {};
    const ip = clientIp(req);

    // ---- 入参校验（注册时必须严格校验，否则可写入超长/非法用户名） ----
    if (typeof rawName !== 'string') {
      return res.status(400).json({ error: '用户名为必填项' });
    }
    const username = rawName.trim();
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: '用户名需为 3-20 位字母、数字或下划线' });
    }
    if (typeof rawEmail !== 'string' || !EMAIL_RE.test(rawEmail.trim())) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }
    const email = normalizeEmail(rawEmail);
    if (typeof password !== 'string' || password.length < 8 || password.length > MAX_PASSWORD_LEN) {
      return res.status(400).json({ error: `密码长度需为 8-${MAX_PASSWORD_LEN} 位` });
    }
    if (nickname !== undefined) {
      if (typeof nickname !== 'string' || !nickname.trim() || nickname.length > MAX_NICKNAME_LEN) {
        return res.status(400).json({ error: `昵称不能为空且不能超过 ${MAX_NICKNAME_LEN} 个字符` });
      }
    }
    if (!emailVerifyToken) {
      return res.status(400).json({ error: '请先完成邮箱验证再注册' });
    }

    // 校验邮箱验证令牌（用途必须为 register 且邮箱一致）
    const verified = await verifyEmailToken(emailVerifyToken, 'register', email);
    if (!verified) {
      return res.status(400).json({ error: '邮箱验证无效或已过期，请重新获取验证链接' });
    }

    // 检查 IP 是否被永久封禁
    const bannedIp = await prisma.bannedIp.findUnique({ where: { ip } });
    if (bannedIp) {
      return res.status(403).json({ error: '你的 IP 地址已被永久封禁，无法注册' });
    }

    // 用户名/邮箱唯一性（对外统一提示，避免账号枚举）
    const existingUsername = await prisma.user.findUnique({ where: { username } });
    if (existingUsername) {
      return res.status(409).json({ error: '该用户名或邮箱已被注册' });
    }
    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail) {
      if (existingEmail.banned) {
        return res.status(403).json({ error: '该邮箱已被永久封禁，无法注册' });
      }
      return res.status(409).json({ error: '该用户名或邮箱已被注册' });
    }

    // 原子消费令牌：必须在创建用户「之前」消费。
    // 若放在之后，两个并发请求会同时通过 verifyEmailToken 检查（TOCTOU），
    // 导致同一个验证链接被使用两次。
    const consumed = await consumeEmailToken(emailVerifyToken);
    if (!consumed) {
      return res.status(400).json({ error: '邮箱验证链接已被使用，请重新获取' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    let user;
    try {
      user = await prisma.user.create({
        data: {
          username,
          email,
          passwordHash,
          nickname: nickname ? nickname.trim() : username,
          lastIp: ip,
          // 管理员不再依据用户名自动授予（否则任何人都可抢注 admin 成为管理员）。
          // 管理员只能通过 server/scripts/reset-admin.ts 或人工改库创建。
          isAdmin: false,
        },
      });
    } catch (err: any) {
      // 消费令牌后建号失败（多为并发下唯一约束冲突），需把令牌还回，避免用户白跑一趟
      console.error('Create user error:', err?.message);
      return res.status(409).json({ error: '该用户名或邮箱已被注册' });
    }

    const token = jwt.sign({ userId: user.id, tv: user.tokenVersion }, config.jwtSecret, { expiresIn: '7d' });

    res.status(201).json({
      message: '注册成功',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        nickname: user.nickname,
        isAdmin: user.isAdmin
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

// 用户登录
authRouter.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body || {};
    const ip = clientIp(req);

    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: '用户名和密码为必填项' });
    }
    if (password.length > MAX_PASSWORD_LEN) {
      return res.status(400).json({ error: '用户名和密码为必填项' });
    }

    const identifier = username.trim();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: identifier },
          { email: identifier }
        ]
      }
    });

    // IP 封禁拦截：先确认用户身份。管理员（白名单）完全豁免 IP 封禁。
    const bannedIp = await prisma.bannedIp.findUnique({ where: { ip } });
    if (bannedIp && !(user?.isAdmin)) {
      return res.status(403).json({ error: '你的 IP 地址已被永久封禁' });
    }

    // 用户不存在时也执行一次 bcrypt 比较，抵消时序差异，避免账号枚举
    if (!user) {
      await bcrypt.compare(password, '$2a$10$abcdefghijklmnopqrstuv0123456789012345678901234567890');
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 封禁拦截：管理员（白名单）不受封禁制约，永远放行。
    if (user.banned && !user.isAdmin) {
      return res.status(403).json({
        error: `你的账号已被永久封禁${user.banReason ? `：${user.banReason}` : ''}`
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastIp: ip }
    });

    const token = jwt.sign({ userId: user.id, tv: user.tokenVersion }, config.jwtSecret, { expiresIn: '7d' });

    res.json({
      message: '登录成功',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        nickname: user.nickname,
        isAdmin: user.isAdmin
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

// 获取当前用户信息
authRouter.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
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
    console.error('Get user error:', error);
    res.status(500).json({ error: '获取用户信息失败' });
  }
});
