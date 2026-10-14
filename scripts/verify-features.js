/**
 * 功能试运行测试：逐项覆盖所有用户功能，找出影响正常使用的问题。
 * 这是「功能是否能用」的验证，而非安全验证。
 * 【P5】改为复用 scripts/verify-common.js：请求加超时，目标地址支持 VERIFY_BASE 覆盖。
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { loadSecret, resolveDatabaseUrl, createChecker, api } = require('./verify-common');

process.env.DATABASE_URL = resolveDatabaseUrl();
const SECRET = loadSecret();
const checker = createChecker('功能试运行结果');
const { check, skipCheck, report } = checker;

(async () => {
  const prisma = new PrismaClient();
  console.log('\n========== 功能试运行测试 ==========\n');

  const uniq = Date.now();
  const admin = await prisma.user.findFirst({ where: { isAdmin: true } });

  // 【P5】夹具自愈：清理上次运行残留的测试房间。
  // 服务端按「IP + 用户」限制同时开设的房间数（User.maxRoomsPerIp 默认 1），
  // 而本脚本需要同时存在 3 个房间（普通房 / 密码房 / 满员小房）。
  // 旧版没有清理，导致：上一次运行残留的房间直接让本次第一个建房就失败，
  // 后续依赖 roomId/pwRoomId/tinyId 的检查连锁失败，且每次运行都会污染下一次。
  const testEmails = ['funcA@test.local', 'funcB@test.local'];
  const preexisting = await prisma.user.findMany({ where: { email: { in: testEmails } }, select: { id: true } });
  if (preexisting.length) {
    const ids = preexisting.map(u => u.id);
    const staleRooms = await prisma.room.findMany({ where: { hostId: { in: ids } }, select: { id: true } });
    for (const r of staleRooms) {
      await prisma.roomBan.deleteMany({ where: { roomId: r.id } });
      await prisma.roomMember.deleteMany({ where: { roomId: r.id } });
      await prisma.room.delete({ where: { id: r.id } }).catch(() => {});
    }
  }

  // 建两个测试用户（带真实密码，用于登录测试）
  const hash = await bcrypt.hash('functest123', 10);
  const userA = await prisma.user.upsert({
    where: { email: 'funcA@test.local' },
    // 【P5】配额调高到 5：本脚本需要同时开 3 个房间，默认 1 会让建房校验一律失败。
    // 这是测试夹具自身的需要，不改变服务端默认值。
    update: { passwordHash: hash, banned: false, tokenVersion: 0, maxRoomsPerIp: 5 },
    create: { username: 'funcA', email: 'funcA@test.local', passwordHash: hash, nickname: '测试A', maxRoomsPerIp: 5 },
  });
  const userB = await prisma.user.upsert({
    where: { email: 'funcB@test.local' },
    update: { passwordHash: hash, banned: false, tokenVersion: 0 },
    create: { username: 'funcB', email: 'funcB@test.local', passwordHash: hash, nickname: '测试B' },
  });

  const tokenA = jwt.sign({ userId: userA.id, tv: userA.tokenVersion }, SECRET, { expiresIn: '1h' });
  const tokenB = jwt.sign({ userId: userB.id, tv: userB.tokenVersion }, SECRET, { expiresIn: '1h' });
  const authA = { Authorization: `Bearer ${tokenA}` };
  const authB = { Authorization: `Bearer ${tokenB}` };

  // ==================== 1. 健康检查 ====================
  console.log('[1] 服务健康检查');
  const health = await api('/api/health');
  check('服务可达 /api/health', health.status === 200 && health.body?.status === 'ok');

  // ==================== 2. 登录 ====================
  console.log('\n[2] 登录');
  const login = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'funcA', password: 'functest123' }),
  });
  check('用用户名+密码可登录', login.status === 200 && !!login.body?.token, `status=${login.status}`);
  const loginEmail = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'funcA@test.local', password: 'functest123' }),
  });
  check('用邮箱+密码可登录', loginEmail.status === 200, `status=${loginEmail.status}`);
  const wrongPw = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'funcA', password: 'wrongpass' }),
  });
  check('错误密码被拒绝（401）', wrongPw.status === 401, `status=${wrongPw.status}`);

  // ==================== 3. 获取当前用户 ====================
  console.log('\n[3] 获取当前用户信息');
  const me = await api('/api/auth/me', { headers: authA });
  check('GET /auth/me 返回当前用户', me.status === 200 && me.body?.user?.username === 'funcA',
    `status=${me.status}`);

  // ==================== 4. 用户资料 ====================
  console.log('\n[4] 用户资料');
  const profile = await api('/api/users/profile', { headers: authA });
  check('GET /users/profile 返回资料', profile.status === 200, `status=${profile.status}`);
  const upd = await api('/api/users/profile', {
    method: 'PATCH', headers: authA, body: JSON.stringify({ nickname: '测试A改' }),
  });
  check('PATCH 修改昵称成功', upd.status === 200 && upd.body?.user?.nickname === '测试A改',
    `status=${upd.status} ${JSON.stringify(upd.body).slice(0,80)}`);
  const badNick = await api('/api/users/profile', {
    method: 'PATCH', headers: authA, body: JSON.stringify({ nickname: '   ' }),
  });
  check('全空格昵称被拒绝', badNick.status === 400, `status=${badNick.status}`);

  // ==================== 5. 用户搜索 ====================
  console.log('\n[5] 用户搜索');
  const search = await api('/api/users/search?q=func', { headers: authA });
  check('搜索用户返回结果', search.status === 200 && Array.isArray(search.body?.users), `status=${search.status}`);
  const found = (search.body?.users || []).some(u => u.username === 'funcB');
  check('能搜到目标用户 funcB', found);

  // ==================== 6. 创建房间 ====================
  console.log('\n[6] 创建房间');
  const roomName = `功能测试房${String(uniq).slice(-6)}`;
  const create = await api('/api/rooms', {
    method: 'POST', headers: authA,
    body: JSON.stringify({ name: roomName, description: '测试描述', maxViewers: 10 }),
  });
  check('创建无密码房间成功', create.status === 201, `status=${create.status} ${JSON.stringify(create.body).slice(0,80)}`);
  const roomId = create.body?.room?.id;
  // 【P5】原断言是 `... === 1 || true`（恒真）。改为真正查一次房间详情确认成员数。
  if (roomId) {
    const createdDetail = await api(`/api/rooms/${roomId}`, { headers: authA });
    check('创建后房主自动成为成员',
      (createdDetail.body?.room?.members || []).some(m => m.user.id === userA.id),
      `members=${JSON.stringify(createdDetail.body?.room?.members?.map(m => m.user.username))}`);
  } else {
    check('创建后房主自动成为成员', false, '房间创建失败，无法校验');
  }

  const createPw = await api('/api/rooms', {
    method: 'POST', headers: authA,
    body: JSON.stringify({ name: `密码房${String(uniq).slice(-6)}`, password: 'pw888888', maxViewers: 5 }),
  });
  check('创建带密码房间成功', createPw.status === 201, `status=${createPw.status}`);
  const pwRoomId = createPw.body?.room?.id;
  check('响应不含明文密码', createPw.body?.room && !('password' in createPw.body.room));
  check('响应含 hasPassword=true', createPw.body?.room?.hasPassword === true);

  // ==================== 7. 房间列表 ====================
  console.log('\n[7] 房间列表');
  const list = await api('/api/rooms', { headers: authB });
  check('房间列表可访问', list.status === 200 && Array.isArray(list.body?.rooms));
  check('列表含分页信息', !!list.body?.pagination);
  const listRoom = (list.body?.rooms || []).find(r => r.name === roomName);
  check('能在列表中找到新房间', !!listRoom);
  const searchRoom = await api(`/api/rooms?search=${encodeURIComponent(roomName)}`, { headers: authB });
  check('按名称搜索房间', searchRoom.status === 200 && (searchRoom.body?.rooms || []).length >= 1);

  // ==================== 8. 房间详情 ====================
  console.log('\n[8] 房间详情');
  const detail = await api(`/api/rooms/${roomId}`, { headers: authB });
  check('获取房间详情', detail.status === 200 && detail.body?.room?.id === roomId);
  check('详情含房主信息', !!detail.body?.room?.host?.username);
  check('详情含成员列表', Array.isArray(detail.body?.room?.members));
  check('详情不含明文密码', !('password' in (detail.body?.room || {})));

  // ==================== 9. 加入房间 ====================
  console.log('\n[9] 加入房间');
  const join = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST', headers: authB, body: JSON.stringify({}),
  });
  check('B 加入无密码房间', join.status === 200, `status=${join.status} ${JSON.stringify(join.body).slice(0,80)}`);

  // 密码房：错误密码拒绝
  const joinWrong = await api(`/api/rooms/${pwRoomId}/join`, {
    method: 'POST', headers: authB, body: JSON.stringify({ password: 'wrong' }),
  });
  check('错误密码被拒绝（403）', joinWrong.status === 403, `status=${joinWrong.status}`);
  // 密码房：正确密码放行
  const joinRight = await api(`/api/rooms/${pwRoomId}/join`, {
    method: 'POST', headers: authB, body: JSON.stringify({ password: 'pw888888' }),
  });
  check('正确密码可加入', joinRight.status === 200, `status=${joinRight.status}`);
  // 房主加入自己房间无需密码
  const joinSelf = await api(`/api/rooms/${pwRoomId}/join`, {
    method: 'POST', headers: authA, body: JSON.stringify({}),
  });
  check('房主进入自己房间无需密码', joinSelf.status === 200, `status=${joinSelf.status}`);

  // ==================== 10. 房间人数上限 ====================
  console.log('\n[10] 房间人数上限');
  // 用一个小房间验证满员拒绝
  const tiny = await api('/api/rooms', {
    method: 'POST', headers: authA, body: JSON.stringify({ name: `小房${String(uniq).slice(-6)}`, maxViewers: 1 }),
  });
  const tinyId = tiny.body?.room?.id;
  // 房主占1位，maxViewers=1，故 B 无法加入
  const joinFull = await api(`/api/rooms/${tinyId}/join`, {
    method: 'POST', headers: authB, body: JSON.stringify({}),
  });
  check('房间满员被拒绝', joinFull.status === 400 && (joinFull.body?.error || '').includes('满'),
    `status=${joinFull.status} ${joinFull.body?.error}`);

  // ==================== 11. 我的房间 ====================
  console.log('\n[11] 我的房间');
  const myHosts = await api('/api/rooms/my/hosts', { headers: authA });
  check('我创建的房间', myHosts.status === 200 && Array.isArray(myHosts.body?.rooms));
  const myJoined = await api('/api/rooms/my/joined', { headers: authB });
  check('我加入的房间', myJoined.status === 200 && Array.isArray(myJoined.body?.rooms));
  const joinedRoom = (myJoined.body?.rooms || []).find(r => r.name === roomName);
  check('B 能看到已加入的房间', !!joinedRoom);

  // ==================== 12. 用户房间（公开视角） ====================
  console.log('\n[12] 查看某用户的房间');
  const userRooms = await api(`/api/users/${userA.id}/rooms`, { headers: authB });
  check('获取用户公开房间', userRooms.status === 200, `status=${userRooms.status}`);
  const pubRoom = (userRooms.body?.rooms || []).find(r => r.name === roomName);
  // 【P5】原写法 `pubRoom ? !('password' in pubRoom) : true` 在房间缺失时静默通过
  check('公开视角能查到该房间', !!pubRoom);
  check('公开视角不含明文密码', !!pubRoom && !('password' in pubRoom));

  // ==================== 13. 房间状态更新 ====================
  console.log('\n[13] 房间状态更新');
  const updStatus = await api(`/api/rooms/${roomId}/status`, {
    method: 'PATCH', headers: authA, body: JSON.stringify({ status: 'PLAYING', currentMovie: '测试片名' }),
  });
  check('房主可开始放映', updStatus.status === 200 && updStatus.body?.room?.status === 'PLAYING',
    `status=${updStatus.status}`);
  const updOther = await api(`/api/rooms/${roomId}/status`, {
    method: 'PATCH', headers: authB, body: JSON.stringify({ status: 'PLAYING' }),
  });
  check('非房主不能改状态（403）', updOther.status === 403, `status=${updOther.status}`);
  const updBack = await api(`/api/rooms/${roomId}/status`, {
    method: 'PATCH', headers: authA, body: JSON.stringify({ status: 'WAITING' }),
  });
  check('房主可结束放映', updBack.status === 200 && updBack.body?.room?.status === 'WAITING');

  // ==================== 14. 离开房间 ====================
  console.log('\n[14] 离开房间');
  const leave = await api(`/api/rooms/${roomId}/leave`, {
    method: 'POST', headers: authB,
  });
  check('成员可离开房间', leave.status === 200, `status=${leave.status}`);
  // 房主离开 = 解散
  const hostLeave = await api(`/api/rooms/${tinyId}/leave`, {
    method: 'POST', headers: authA,
  });
  check('房主离开（解散房间）', hostLeave.status === 200, `status=${hostLeave.status}`);

  // ==================== 15. 房间图片 ====================
  console.log('\n[15] 房间图片');
  // 上传一张 1x1 透明 PNG 的 base64
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const imgUpd = await api(`/api/rooms/${pwRoomId}/images`, {
    method: 'PUT', headers: authA, body: JSON.stringify({ images: [tinyPng] }),
  });
  check('房主可更新房间图片', imgUpd.status === 200, `status=${imgUpd.status} ${JSON.stringify(imgUpd.body).slice(0,80)}`);
  const imgArr = imgUpd.body?.images;
  check('返回图片路径数组', Array.isArray(imgArr) && imgArr.length === 1 && imgArr[0].startsWith('/uploads/'),
    JSON.stringify(imgArr ?? null)?.slice(0, 80) ?? 'undefined');
  // 图片可公开访问
  if (imgArr && imgArr[0]) {
    const imgRes = await fetch(BASE + imgArr[0]);
    check('上传的图片可公开访问', imgRes.status === 200, `status=${imgRes.status}`);
  }
  const imgOther = await api(`/api/rooms/${pwRoomId}/images`, {
    method: 'PUT', headers: authB, body: JSON.stringify({ images: [tinyPng] }),
  });
  check('非房主不能改图片（403）', imgOther.status === 403, `status=${imgOther.status}`);

  // ==================== 16. 验证码接口 ====================
  console.log('\n[16] 滑块验证码');
  const cap = await api('/api/auth/captcha/challenge', { method: 'POST' });
  check('获取验证码挑战', cap.status === 200 && !!cap.body?.id, `status=${cap.status}`);
  check('返回带缺口的底图', typeof cap.body?.bg === 'string' && cap.body.bg.startsWith('data:image/png'));
  check('不下发正确位置（无 gap 字段）', !('gap' in (cap.body || {})));
  const capVer = await api('/api/auth/captcha/verify', {
    method: 'POST', body: JSON.stringify({ id: cap.body?.id, pos: 0.5 }),
  });
  // 0.5 不一定命中，但接口必须正常响应（400 或 200 均可，不能 500）
  check('验证码校验接口正常响应', capVer.status === 200 || capVer.status === 400, `status=${capVer.status}`);

  // ==================== 17. 发送验证链接（控制台模式） ====================
  console.log('\n[17] 发送邮箱验证链接');
  // 需先过滑块。我们无法预知 gap，直接测试「未通过滑块」的拒绝路径
  const noCaptcha = await api('/api/auth/send-verify-link', {
    method: 'POST', body: JSON.stringify({ email: 'x@test.local', purpose: 'register' }),
  });
  check('未完成滑块被拒绝（400）', noCaptcha.status === 400, `status=${noCaptcha.status}`);
  // 非法 purpose
  const badPurpose = await api('/api/auth/send-verify-link', {
    method: 'POST', body: JSON.stringify({ email: 'x@test.local', purpose: 'hack', captchaToken: 'x' }),
  });
  check('非法操作类型被拒绝', badPurpose.status === 400, `status=${badPurpose.status}`);

  // ==================== 18. 改密码 ====================
  console.log('\n[18] 修改密码');
  const cpNoToken = await api('/api/users/change-password', {
    method: 'POST', headers: authB, body: JSON.stringify({ newPassword: 'newpassword123' }),
  });
  check('普通用户改密无邮箱令牌被拒', cpNoToken.status === 400, `status=${cpNoToken.status}`);
  const shortPw = await api('/api/users/change-password', {
    method: 'POST', headers: authB, body: JSON.stringify({ newPassword: 'short' }),
  });
  check('新密码过短被拒', shortPw.status === 400, `status=${shortPw.status}`);

  // ==================== 19. 管理员接口权限 ====================
  console.log('\n[19] 管理员接口权限');
  if (admin) {
    const adminToken = jwt.sign({ userId: admin.id, tv: admin.tokenVersion }, SECRET, { expiresIn: '1h' });
    const a = { Authorization: `Bearer ${adminToken}` };
    const adminUsers = await api('/api/admin/users', { headers: a });
    check('管理员可获取用户列表', adminUsers.status === 200 && Array.isArray(adminUsers.body?.users),
      `status=${adminUsers.status}`);
    const adminIps = await api('/api/admin/banned-ips', { headers: a });
    check('管理员可获取封禁 IP 列表', adminIps.status === 200, `status=${adminIps.status}`);
  }
  const nonAdminUsers = await api('/api/admin/users', { headers: authB });
  check('非管理员访问用户列表被拒（403）', nonAdminUsers.status === 403, `status=${nonAdminUsers.status}`);

  // ==================== 20. 未认证访问保护 ====================
  console.log('\n[20] 未认证访问保护');
  const noAuth1 = await api('/api/rooms');
  check('未认证访问房间列表被拒（401）', noAuth1.status === 401, `status=${noAuth1.status}`);
  const noAuth2 = await api('/api/users/profile');
  check('未认证访问用户资料被拒（401）', noAuth2.status === 401, `status=${noAuth2.status}`);
  const noAuth3 = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
  check('未认证创建房间被拒（401）', noAuth3.status === 401, `status=${noAuth3.status}`);

  // 清理测试数据
  for (const rid of [roomId, pwRoomId, tinyId]) {
    if (rid) {
      await prisma.roomBan.deleteMany({ where: { roomId: rid } });
      await prisma.roomMember.deleteMany({ where: { roomId: rid } });
      await prisma.room.delete({ where: { id: rid } }).catch(() => {});
    }
  }
  await prisma.user.deleteMany({ where: { email: { in: ['funcA@test.local', 'funcB@test.local'] } } }).catch(() => {});

  await prisma.$disconnect();

  report();
  process.exit(checker.counts().fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
