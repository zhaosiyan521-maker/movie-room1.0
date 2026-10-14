/**
 * 端到端回归测试：验证完整业务流程与安全修复协同工作。
 * 覆盖：邮箱验证→注册→登录→建房→加入→改密→令牌重放拒绝→tokenVersion 失效
 * 可从任意目录运行；目标地址可用 VERIFY_BASE 覆盖。
 *
 * 【P5 修复】
 *  1. 「重放已消费的邮箱令牌被拒」之前**根本没带令牌**，400 来自参数校验，
 *     该安全属性从未被验证。现改为重发**同一个** regToken。
 *  2. 「注册 admin 不会自动提权」在 admin 已被占用时直接 check(..., true) 记为通过。
 *     现改为 skipCheck —— 跳过不计入通过。
 *  3. 清理不再 `usedToken.deleteMany({})`（会清空全表重放防护、让历史上所有已用
 *     邮箱链接复活）与 `user.deleteMany({ email: { contains: 'e2e' } })`（可能误删
 *     真实账号），改为按本次运行产生的 id / jti 精确清理。
 *  4. 所有请求与断言加超时/轮询。
 */
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { BASE, loadSecret, resolveDatabaseUrl, createChecker, api, waitFor } = require('./verify-common');

const SECRET = loadSecret();
process.env.DATABASE_URL = resolveDatabaseUrl();
const checker = createChecker('结果');
const { check, skipCheck, report } = checker;

/** 走完整邮箱验证流程取得 register 令牌（SMTP 未配置时链接只在服务端控制台打印，
 *  这里直接用同一密钥签发等价令牌，模拟用户点邮件链接后的状态） */
function issueToken(email, purpose) {
  return jwt.sign({ email, purpose, jti: 'e2e-' + Math.random().toString(36).slice(2) }, SECRET, { expiresIn: '30m' });
}

/** 取出令牌的 jti，便于本次运行精确清理 used_tokens */
function jtiOf(token) {
  try { return jwt.decode(token)?.jti || null; } catch { return null; }
}

(async () => {
  const prisma = new PrismaClient();
  console.log('\n========== 端到端回归测试 ==========\n');

  const uniq = Date.now();
  const userName = 'e2e' + String(uniq).slice(-8);
  const email = `${userName}@example.com`;
  const password = 'e2epassword123';

  /** 本次运行消费过的 jti（精确清理用） */
  const consumedJtis = [];
  const createdEmails = [];
  /** 本次运行创建的房间 id（必须在 try 之外声明，finally 里的清理才能访问到） */
  let roomId = null;

  try {
    // ---------- 注册 ----------
    console.log('[注册]');
    const regToken = issueToken(email, 'register');
    const regJti = jtiOf(regToken);
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: userName, email, password, emailVerifyToken: regToken }),
    });
    check('合法邮箱令牌可完成注册', reg.status === 201,
      `status=${reg.status} ${JSON.stringify(reg.body).slice(0, 100)}`);
    if (regJti) consumedJtis.push(regJti);
    createdEmails.push(email);

    // 令牌重放：必须重发**同一个**令牌，否则验证的不是重放防护
    const replay = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: userName + 'x',
        email: `replay_${uniq}@example.com`,
        password,
        emailVerifyToken: regToken, // ← 同一个已消费令牌
      }),
    });
    check('重放已消费的邮箱令牌被拒', replay.status === 400,
      `status=${replay.status} body=${JSON.stringify(replay.body)}`);
    check('重放被拒的原因指向邮箱验证/已使用',
      /验证|使用/.test(String(replay.body?.error || '')), `error=${replay.body?.error}`);

    // ---------- 用户名校验 ----------
    console.log('\n[注册校验]');
    const n1 = `x${uniq}@e.com`;
    const badName = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'ab', email: n1, password, emailVerifyToken: issueToken(n1, 'register') }),
    });
    check('过短用户名被拒（3位以下）', badName.status === 400, `status=${badName.status}`);

    const n2 = `y${uniq}@e.com`;
    const badName2 = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'bad name!', email: n2, password, emailVerifyToken: issueToken(n2, 'register') }),
    });
    check('含非法字符的用户名被拒', badName2.status === 400, `status=${badName2.status}`);

    const n3 = `z${uniq}@e.com`;
    const badPw = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'okname' + String(uniq).slice(-6), email: n3, password: 'short',
        emailVerifyToken: issueToken(n3, 'register'),
      }),
    });
    check('过短密码被拒', badPw.status === 400, `status=${badPw.status}`);

    // ---------- 管理员抢注 ----------
    console.log('\n[管理员]');
    const hijackEmail = `hijack${uniq}@e.com`;
    const adminReg = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'admin', email: hijackEmail, password,
        emailVerifyToken: issueToken(hijackEmail, 'register'),
      }),
    });
    if (adminReg.status === 201) {
      const u = await prisma.user.findUnique({ where: { email: hijackEmail } });
      check('注册 admin 不会自动获得管理员权限', u && u.isAdmin === false, `isAdmin=${u?.isAdmin}`);
      await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
    } else if (adminReg.status === 409) {
      // 【P5】旧写法 check(..., true) 把「跳过」记成「通过」；这里单独计数
      skipCheck('注册 admin 不会自动获得管理员权限', 'admin 用户名已被占用，未走到提权判定');
    } else {
      check('注册 admin 不会自动获得管理员权限', false, `status=${adminReg.status}`);
    }

    // ---------- 登录 ----------
    console.log('\n[登录]');
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: userName, password }),
    });
    check('注册后可正常登录', login.status === 200 && !!login.body?.token, `status=${login.status}`);
    const token = login.body?.token || '';
    const auth = { Authorization: `Bearer ${token}` };

    if (token) {
      // ---------- 建房 ----------
      console.log('\n[房间]');
      const room = await api('/api/rooms', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ name: `e2e房${String(uniq).slice(-6)}`, password: 'pw123456', maxViewers: 5 }),
      });
      check('创建带密码房间成功', room.status === 201, `status=${room.status}`);
      roomId = room.body?.room?.id;

      const blank = await api('/api/rooms', {
        method: 'POST', headers: auth, body: JSON.stringify({ name: '   ' }),
      });
      check('全空格房间名被拒', blank.status === 400, `status=${blank.status}`);

      const badMv = await api('/api/rooms', {
        method: 'POST', headers: auth, body: JSON.stringify({ name: `bad${uniq}`, maxViewers: 'abc' }),
      });
      check('maxViewers 传字符串被拒（类型混淆）', badMv.status === 400, `status=${badMv.status}`);

      const badStatus = await api(`/api/rooms/${roomId}/status`, {
        method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'HACKED' }),
      });
      check('非法房间状态被拒', badStatus.status === 400, `status=${badStatus.status}`);
    }

    // ---------- 改密与 tokenVersion ----------
    console.log('\n[令牌吊销]');
    if (token) {
      const newPw = 'newpassword456';
      const cpToken = issueToken(email, 'change-password');
      const cpJti = jtiOf(cpToken);
      const cp = await api('/api/users/change-password', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ newPassword: newPw, emailVerifyToken: cpToken }),
      });
      check('凭邮箱令牌可修改密码', cp.status === 200,
        `status=${cp.status} ${JSON.stringify(cp.body).slice(0, 80)}`);
      if (cpJti) consumedJtis.push(cpJti);

      // 旧 token 应立即失效（tokenVersion 自增）
      const after = await api('/api/rooms', { headers: auth });
      check('改密后旧 JWT 立即失效', after.status === 401, `status=${after.status}`);

      // 令牌重放：用同一个已消费的改密令牌
      const cpReplay = await api('/api/users/change-password', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ newPassword: 'another123456', emailVerifyToken: cpToken }),
      });
      check('重放改密令牌被拒', cpReplay.status !== 200, `status=${cpReplay.status}`);

      // 新密码登录
      const relogin = await api('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ username: userName, password: newPw }),
      });
      check('可用新密码登录', relogin.status === 200, `status=${relogin.status}`);
    }
  } finally {
    // 【P5】精确清理：只删本次运行创建的数据。
    // 不再 usedToken.deleteMany({})（会让历史上所有已用邮箱链接复活），
    // 也不再按 email contains 'e2e' 模糊删除（可能误删真实账号）。
    try {
      if (roomId) {
        await prisma.roomMember.deleteMany({ where: { roomId } });
        await prisma.roomBan.deleteMany({ where: { roomId } });
        await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
      }
      if (consumedJtis.length) {
        await prisma.usedToken.deleteMany({ where: { jti: { in: consumedJtis } } }).catch(() => {});
      }
      if (createdEmails.length) {
        const users = await prisma.user.findMany({ where: { email: { in: createdEmails } }, select: { id: true } });
        const ids = users.map(u => u.id);
        if (ids.length) {
          await prisma.roomMember.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
          await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
        }
      }
    } catch (e) {
      console.error('清理测试数据失败:', e.message);
    }
    await prisma.$disconnect();
  }

  report();
  process.exit(checker.counts().fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });

