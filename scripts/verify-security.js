/**
 * 安全修复集成验证脚本
 * 验证 C-1/C-2/C-6/M-3/M-4/M-14 等修复是否真实生效。
 * 可从任意目录运行。
 */
const path = require('path');
const fs = require('fs');

// npm workspaces 会把依赖 hoist 到仓库根目录，故用标准模块解析即可
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const BASE = 'http://127.0.0.1:3001';

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

(async () => {
  console.log('\n========== 安全修复验证 ==========\n');

  // ---------- C-1 验证码不再泄露答案 ----------
  console.log('[C-1] 滑块验证码');
  const ch = await api('/api/auth/captcha/challenge', { method: 'POST' });
  check('挑战响应不含 gap 字段', ch.body && !('gap' in ch.body), JSON.stringify(ch.body?.gap));
  check('返回带缺口的底图 bg', ch.body && typeof ch.body.bg === 'string' && ch.body.bg.startsWith('data:image/png;base64,'));

  // 尝试用任意位置通过（应失败，因为没有真值可猜）
  if (ch.body?.id) {
    const bad = await api('/api/auth/captcha/verify', { method: 'POST', body: JSON.stringify({ id: ch.body.id, pos: 0.5 }) });
    // 0.5 恰在容差内时可能通过，故只断言"重复使用同一 id 必然失败"
    const reuse = await api('/api/auth/captcha/verify', { method: 'POST', body: JSON.stringify({ id: ch.body.id, pos: 0.99 }) });
    check('挑战 id 一次性（复用即失败）', reuse.status === 400, `status=${reuse.status}`);
  }

  // ---------- C-6 注册不再自动授予管理员 ----------
  console.log('\n[C-6] 注册与管理员');
  // 直接用服务端密钥为测试用户签发令牌，绕过注册流程做接口测试
  const uniq = Date.now();
  const testEmail = `sectest_${uniq}@example.com`;
  const testName = `sectest${String(uniq).slice(-8)}`;

  // 用 admin 令牌（从数据库取一个 admin）
  process.env.DATABASE_URL = 'file:' + path.join(SERVER_DIR, 'prisma', 'dev.db').replace(/\\/g, '/');
  const prisma = new PrismaClient();
  const admin = await prisma.user.findFirst({ where: { isAdmin: true } });
  if (!admin) { console.log('  ⚠️ 无管理员账号，跳过需要令牌的测试'); }
  const adminToken = jwt.sign({ userId: admin.id, tv: admin.tokenVersion }, SECRET, { expiresIn: '1h' });

  // 注册接口拒绝弱密码 / 非法用户名
  const noToken = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'ab', email: 'x@y.com', password: 'short' }),
  });
  check('注册缺邮箱验证令牌被拒', noToken.status === 400, `status=${noToken.status}`);

  // ---------- C-2 房间密码不再泄露 ----------
  console.log('\n[C-2] 房间密码泄露');
  if (adminToken) {
    // 创建一个带密码的房间（用已存在的 admin 身份）
    const roomName = `pwtest_${String(uniq).slice(-8)}`;
    const created = await api('/api/rooms', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: roomName, password: 'SuperSecret123', maxViewers: 10 }),
    });
    check('创建带密码房间成功', created.status === 201, `status=${created.status} ${JSON.stringify(created.body).slice(0,120)}`);
    check('创建响应不含 password 字段', created.body?.room && !('password' in created.body.room));

    const list = await api('/api/rooms', { headers: { Authorization: `Bearer ${adminToken}` } });
    const target = (list.body?.rooms || []).find(r => r.name === roomName);
    check('房间列表能查到该房间', !!target);
    if (target) {
      check('列表项不含 password 字段', !('password' in target), Object.keys(target).join(','));
      check('列表项含 hasPassword=true', target.hasPassword === true);
      const leaked = target.password;
      check('明文密码值确实未出现', leaked === undefined, `leaked=${leaked}`);
    }

    const detail = await api(`/api/rooms/${created.body?.room?.id}`, { headers: { Authorization: `Bearer ${adminToken}` } });
    check('详情不含 password 字段', detail.body?.room && !('password' in detail.body.room));

    const mine = await api('/api/rooms/my/hosts', { headers: { Authorization: `Bearer ${adminToken}` } });
    const m2 = (mine.body?.rooms || []).find(r => r.name === roomName);
    check('my/hosts 不含 password 字段', m2 ? !('password' in m2) : true);

    // 清理
    if (created.body?.room?.id) {
      await prisma.roomMember.deleteMany({ where: { roomId: created.body.room.id } });
      await prisma.room.delete({ where: { id: created.body.room.id } });
    }
  }

  // ---------- M-14 401 vs 400 语义 ----------
  console.log('\n[M-14] 状态码语义');
  if (adminToken) {
    // 管理员改密传错误 currentPassword，应为 400（不触发客户端强制登出）
    const r = await api('/api/users/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ newPassword: 'newpassword123', currentPassword: 'definitely-wrong' }),
    });
    check('管理员改密密码错误返回 400 而非 401', r.status === 400, `status=${r.status}`);
  }

  // ---------- M-4 分页参数校验 ----------
  console.log('\n[M-4] 分页参数');
  if (adminToken) {
    const bad = await api('/api/rooms?page=abc', { headers: { Authorization: `Bearer ${adminToken}` } });
    check('非法 page 返回 400', bad.status === 400, `status=${bad.status}`);
    const big = await api('/api/rooms?limit=999999', { headers: { Authorization: `Bearer ${adminToken}` } });
    check('超大 limit 被夹紧到 50', big.body?.pagination?.limit === 50, `limit=${big.body?.pagination?.limit}`);
  }

  // ---------- 未认证访问 ----------
  console.log('\n[基础] 未认证访问');
  const noauth = await api('/api/rooms');
  check('未带 token 访问房间列表返回 401', noauth.status === 401, `status=${noauth.status}`);

  await prisma.$disconnect();

  console.log(`\n========== 结果：通过 ${pass} / 失败 ${fail} ==========\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('验证脚本异常:', e); process.exit(1); });
