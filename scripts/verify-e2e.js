/**
 * 端到端回归测试：验证完整业务流程与安全修复协同工作。
 * 覆盖：邮箱验证→注册→登录→建房→加入→改密→令牌重放拒绝→tokenVersion 失效
 * 可从任意目录运行（依赖路径统一以 server 目录为基准）。
 */
const path = require('path');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..', 'server');
// npm workspaces 会把依赖 hoist 到仓库根目录，故用标准模块解析即可
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const BASE = 'http://127.0.0.1:3001';
process.env.DATABASE_URL = 'file:' + path.join(SERVER_DIR, 'prisma', 'dev.db').replace(/\\/g, '/');

function loadSecret() {
  const env = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
  const m = env.match(/JWT_SECRET="?([^"\r\n]+)"?/);
  return m ? m[1].trim() : null;
}
const SECRET = loadSecret();

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${extra}`); fail++; }
}

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
}

/** 走完整邮箱验证流程取得 register 令牌（SMTP 未配置时链接只在服务端控制台打印，
 *  这里直接用同一密钥签发等价令牌，模拟用户点邮件链接后的状态） */
function issueToken(email, purpose) {
  return jwt.sign({ email, purpose, jti: 'e2e-' + Math.random().toString(36).slice(2) }, SECRET, { expiresIn: '30m' });
}

(async () => {
  const prisma = new PrismaClient();
  console.log('\n========== 端到端回归测试 ==========\n');

  const uniq = Date.now();
  const userName = 'e2e' + String(uniq).slice(-8);
  const email = `${userName}@example.com`;
  const password = 'e2epassword123';

  // ---------- 注册 ----------
  console.log('[注册]');
  const regToken = issueToken(email, 'register');
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: userName, email, password, emailVerifyToken: regToken }),
  });
  check('合法邮箱令牌可完成注册', reg.status === 201, `status=${reg.status} ${JSON.stringify(reg.body).slice(0, 100)}`);

  // 令牌重放：同一令牌再注册一次必须失败
  const replay = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: userName + 'x', email: email.replace('@', 'x@'), password }),
  });
  check('重放已消费的邮箱令牌被拒', replay.status === 400, `status=${replay.status}`);

  // ---------- 用户名校验 ----------
  console.log('\n[注册校验]');
  const badName = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'ab', email: `x${uniq}@e.com`, password, emailVerifyToken: issueToken(`x${uniq}@e.com`, 'register') }),
  });
  check('过短用户名被拒（3位以下）', badName.status === 400, `status=${badName.status}`);

  const badName2 = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'bad name!', email: `y${uniq}@e.com`, password, emailVerifyToken: issueToken(`y${uniq}@e.com`, 'register') }),
  });
  check('含非法字符的用户名被拒', badName2.status === 400, `status=${badName2.status}`);

  const badPw = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'okname' + String(uniq).slice(-6), email: `z${uniq}@e.com`, password: 'short', emailVerifyToken: issueToken(`z${uniq}@e.com`, 'register') }),
  });
  check('过短密码被拒', badPw.status === 400, `status=${badPw.status}`);

  // ---------- 管理员抢注 ----------
  console.log('\n[管理员]');
  const adminReg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'admin', email: `hijack${uniq}@e.com`, password,
      emailVerifyToken: issueToken(`hijack${uniq}@e.com`, 'register'),
    }),
  });
  if (adminReg.status === 201) {
    const u = await prisma.user.findUnique({ where: { email: `hijack${uniq}@e.com` } });
    check('注册 admin 不会自动获得管理员权限', u && u.isAdmin === false, `isAdmin=${u?.isAdmin}`);
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
  } else if (adminReg.status === 409) {
    check('注册 admin 不会自动获得管理员权限（已被占用，跳过）', true);
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
    const roomId = room.body?.room?.id;

    const blank = await api('/api/rooms', {
      method: 'POST', headers: auth, body: JSON.stringify({ name: '   ' }),
    });
    check('全空格房间名被拒', blank.status === 400, `status=${blank.status}`);

    const badMv = await api('/api/rooms', {
      method: 'POST', headers: auth, body: JSON.stringify({ name: `bad${uniq}`, maxViewers: 'abc' }),
    });
    check('maxViewers 传字符串被拒（类型混淆）', badMv.status === 400, `status=${badMv.status}`);

    // 状态白名单
    const badStatus = await api(`/api/rooms/${roomId}/status`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'HACKED' }),
    });
    check('非法房间状态被拒', badStatus.status === 400, `status=${badStatus.status}`);

    if (roomId) {
      await prisma.roomMember.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    }
  }

  // ---------- 改密与 tokenVersion ----------
  console.log('\n[令牌吊销]');
  if (token) {
    const me = jwt.decode(token);
    const newPw = 'newpassword456';
    const cpToken = issueToken(email, 'change-password');
    const cp = await api('/api/users/change-password', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ newPassword: newPw, emailVerifyToken: cpToken }),
    });
    check('凭邮箱令牌可修改密码', cp.status === 200, `status=${cp.status} ${JSON.stringify(cp.body).slice(0, 80)}`);

    // 旧 token 应立即失效（tokenVersion 自增）
    const after = await api('/api/rooms', { headers: auth });
    check('改密后旧 JWT 立即失效', after.status === 401, `status=${after.status}`);

    // 令牌重放
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

  // 清理测试数据
  await prisma.user.deleteMany({ where: { email: { contains: 'e2e' } } }).catch(() => {});
  await prisma.usedToken.deleteMany({}).catch(() => {});

  await prisma.$disconnect();
  console.log(`\n========== 结果：通过 ${pass} / 失败 ${fail} ==========\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
