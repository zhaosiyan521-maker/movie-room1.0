/**
 * 安全修复集成验证脚本
 * 验证 C-1/C-2/C-6/M-3/M-4/M-14 等修复是否真实生效。
 * 可从任意目录运行；目标地址可用 VERIFY_BASE 覆盖。
 *
 * 【P5 修复】
 *  1. 无管理员账号时不再对 null 取 `.id`（旧版会抛 TypeError 直接终止整个安全套件），
 *     改为跳过并单独计数 —— 「跳过」不再被算作「通过」。
 *  2. 「注册缺邮箱验证令牌被拒」之前用的是非法用户名 + 过短密码，请求根本没走到
 *     令牌校验就被参数校验拒绝：即使删掉邮箱验证要求，该断言依然通过。
 *     现改为「合法用户名 + 合法邮箱 + 合规密码 + 不带令牌」，并断言错误信息指向邮箱验证。
 *  3. 「超大 limit 被夹紧到 50」原先用 limit=999999，而服务端默认值本身就会夹到 50，
 *     删掉夹紧逻辑该断言依然成立。改为分别验证 limit=7 保持 7 与 limit=500 夹到 50。
 *  4. my/hosts 的密码泄露检查在房间不存在时会静默通过，现要求房间必须存在。
 *  5. 所有请求加超时。
 */
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { SERVER_DIR, loadSecret, resolveDatabaseUrl, createChecker, api } = require('./verify-common');

const SECRET = loadSecret();
const checker = createChecker('结果');
const { check, skipCheck, report } = checker;

(async () => {
  console.log('\n========== 安全修复验证 ==========\n');

  // ---------- C-1 验证码不再泄露答案 ----------
  console.log('[C-1] 滑块验证码');
  const ch = await api('/api/auth/captcha/challenge', { method: 'POST' });
  check('挑战响应不含 gap 字段', ch.body && !('gap' in ch.body), JSON.stringify(ch.body?.gap));
  check('返回带缺口的底图 bg',
    ch.body && typeof ch.body.bg === 'string' && ch.body.bg.startsWith('data:image/png;base64,'));

  if (ch.body?.id) {
    // 先用 0.5 试一次（可能恰好落在 3% 容差内），再复用同一 id 必然失败
    await api('/api/auth/captcha/verify', { method: 'POST', body: JSON.stringify({ id: ch.body.id, pos: 0.5 }) });
    const reuse = await api('/api/auth/captcha/verify', { method: 'POST', body: JSON.stringify({ id: ch.body.id, pos: 0.99 }) });
    check('挑战 id 一次性（复用即失败）', reuse.status === 400, `status=${reuse.status}`);
  } else {
    skipCheck('挑战 id 一次性（复用即失败）', '未取到挑战 id');
  }

  // ---------- 数据库 / 管理员令牌 ----------
  process.env.DATABASE_URL = resolveDatabaseUrl();
  const prisma = new PrismaClient();
  const admin = await prisma.user.findFirst({ where: { isAdmin: true } });
  let adminToken = null;
  if (admin) {
    adminToken = jwt.sign({ userId: admin.id, tv: admin.tokenVersion }, SECRET, { expiresIn: '1h' });
  } else {
    // 【P5】旧实现在这里继续用 admin.id，抛 TypeError 终止整套验证，
    // 且外界看不出「需要管理员令牌的检查一条都没跑」。
    skipCheck('依赖管理员令牌的全部检查', '数据库中不存在管理员账号（可先用 ADMIN_PASSWORD=... npx ts-node scripts/create-admin.ts 创建）');
  }

  const uniq = Date.now();

  // ---------- 邮箱验证令牌门禁（参数必须合法，否则验证的不是该属性） ----------
  console.log('\n[注册] 邮箱验证令牌门禁');
  const validName = `notoken${String(uniq).slice(-8)}`;
  const validEmail = `notoken_${uniq}@example.com`;
  const noToken = await api('/api/auth/register', {
    method: 'POST',
    // 合法用户名 + 合法邮箱 + 合规密码（8 位以上），仅缺 emailVerifyToken
    body: JSON.stringify({ username: validName, email: validEmail, password: 'validpassword123' }),
  });
  check('合法入参但缺邮箱验证令牌被拒', noToken.status === 400,
    `status=${noToken.status} body=${JSON.stringify(noToken.body)}`);
  check('拒绝原因指向邮箱验证（而非参数校验）',
    /邮箱|验证/.test(String(noToken.body?.error || '')), `error=${noToken.body?.error}`);

  // 参数非法（用户名过短）另作一条独立断言，不再冒充令牌门禁
  const shortName = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'ab', email: `short_${uniq}@example.com`, password: 'validpassword123' }),
  });
  check('非法用户名被拒', shortName.status === 400, `status=${shortName.status}`);

  // ---------- C-2 房间密码不再泄露 ----------
  console.log('\n[C-2] 房间密码泄露');
  if (adminToken) {
    const roomName = `pwtest_${String(uniq).slice(-8)}`;
    const created = await api('/api/rooms', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: roomName, password: 'SuperSecret123', maxViewers: 10 }),
    });
    check('创建带密码房间成功', created.status === 201,
      `status=${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);
    check('创建响应不含 password 字段', created.body?.room && !('password' in created.body.room));

    const list = await api('/api/rooms', { headers: { Authorization: `Bearer ${adminToken}` } });
    const target = (list.body?.rooms || []).find(r => r.name === roomName);
    check('房间列表能查到该房间', !!target);
    if (target) {
      check('列表项不含 password 字段', !('password' in target), Object.keys(target).join(','));
      check('列表项含 hasPassword=true', target.hasPassword === true);
      check('明文密码值确实未出现', target.password === undefined, `leaked=${target.password}`);
    }

    const detail = await api(`/api/rooms/${created.body?.room?.id}`, { headers: { Authorization: `Bearer ${adminToken}` } });
    check('详情不含 password 字段', detail.body?.room && !('password' in detail.body.room));

    const mine = await api('/api/rooms/my/hosts', { headers: { Authorization: `Bearer ${adminToken}` } });
    const m2 = (mine.body?.rooms || []).find(r => r.name === roomName);
    // 【P5】旧写法 `m2 ? !('password' in m2) : true` 在房间缺失时静默通过
    check('my/hosts 能查到该房间', !!m2);
    check('my/hosts 不含 password 字段', !!m2 && !('password' in m2));

    // 清理
    if (created.body?.room?.id) {
      await prisma.roomMember.deleteMany({ where: { roomId: created.body.room.id } });
      await prisma.room.delete({ where: { id: created.body.room.id } }).catch(() => {});
    }
  }

  // ---------- M-14 401 vs 400 语义 ----------
  console.log('\n[M-14] 状态码语义');
  if (adminToken) {
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

    // 【P5】用可区分的取值，否则断言在「夹紧逻辑被删除」时依然成立（默认值也是 50）
    const seven = await api('/api/rooms?limit=7', { headers: { Authorization: `Bearer ${adminToken}` } });
    check('limit=7 原样生效（说明 limit 真的被读取）', seven.body?.pagination?.limit === 7,
      `limit=${seven.body?.pagination?.limit}`);
    const big = await api('/api/rooms?limit=500', { headers: { Authorization: `Bearer ${adminToken}` } });
    check('limit=500 被夹紧到 50', big.body?.pagination?.limit === 50, `limit=${big.body?.pagination?.limit}`);
  }

  // ---------- 未认证访问 ----------
  console.log('\n[基础] 未认证访问');
  const noauth = await api('/api/rooms');
  check('未带 token 访问房间列表返回 401', noauth.status === 401, `status=${noauth.status}`);

  await prisma.$disconnect();

  report();
  process.exit(checker.counts().fail > 0 ? 1 : 0);
})().catch(e => { console.error('验证脚本异常:', e); process.exit(1); });

