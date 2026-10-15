/**
 * 【公共房间需求】回归测试。
 *
 * 锁死的不变量（逐条对应需求）：
 *   1. 只有管理员账号创建的房间才是「公共房间」；
 *   2. 未设置放映密码时，非管理员**绝对**无法通过放映通道（先设置、后清除，两次都验）；
 *   3. 放映密码是**一次性**的：首位用户使用后立即作废，第二个人拿同一个密码进不来；
 *   4. 放映权限是**排他**的：已有放映人时，另一个人无法抢占；
 *   5. 放映人拥有放映权限（可用 host 类事件），但**不能解散房间**；
 *   6. 管理员免密可进，且**不消耗**密码；
 *   7. 「本场结束」（host-screening-end）后放映权限作废、通道回到「未设密码」；
 *   8. 放映人掉线后在宽限期内仍保留权限（可刷新回来），超时才释放；
 *   9. 公共房间在**无人时也不会被自动解散**。
 *
 * 运行：node scripts/verify-public-room.js
 */
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const {
  BASE, loadSecret, resolveDatabaseUrl, sleep, waitFor, connectSocket, createChecker, api,
} = require('./verify-common');

process.env.DATABASE_URL = resolveDatabaseUrl();
const SECRET = loadSecret();
const checker = createChecker('公共房间结果');
const { check, report } = checker;

(async () => {
  const prisma = new PrismaClient();
  console.log('\n========== 公共房间（放映通道）回归 ==========\n');

  const uniq = Date.now();
  const hash = await bcrypt.hash('publicroom123', 10);
  const mkUser = (tag, isAdmin = false) => prisma.user.create({
    data: {
      username: `pr${tag}${String(uniq).slice(-6)}`,
      email: `pr${tag}${uniq}@e.com`,
      passwordHash: hash,
      nickname: tag.toUpperCase().slice(0, 10),
      isAdmin,
      maxRoomsPerIp: isAdmin ? 5 : 1,
    },
  });

  const adminUser = await mkUser('adm', true);
  const alice = await mkUser('alice');
  const bob = await mkUser('bob');

  const sign = (u) => jwt.sign({ userId: u.id, tv: u.tokenVersion }, SECRET, { expiresIn: '1h' });

  let adminSock = null;
  let aliceSock = null;
  const createdRooms = [];
  const createdUsers = [adminUser.id, alice.id, bob.id];

  try {
    // ---- 用管理员身份通过 HTTP 房间接口创建「公共房间」 ----
    // 走真实接口而非直接插库：这样也顺带覆盖「管理员能创建房间」这条路径。
    const adminHeaders = { Authorization: `Bearer ${sign(adminUser)}` };
    const createRes = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ name: `公共房间-${String(uniq).slice(-5)}`, maxViewers: 10 }),
    });
    if (!createRes.ok) {
      throw new Error(`创建公共房间失败：${createRes.status} ${await createRes.text()}`);
    }
    const pubRoom = (await createRes.json()).room;
    createdRooms.push(pubRoom.id);
    check('管理员可以创建房间（公共房间）', !!pubRoom.id);

    // 再建一个普通房间（普通用户创建）用于对比：它不应被当作公共房间
    const aliceHeaders = { Authorization: `Bearer ${sign(alice)}` };
    const plainRes = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...aliceHeaders },
      body: JSON.stringify({ name: `普通房间-${String(uniq).slice(-5)}`, maxViewers: 5 }),
    });
    const plainRoom = (await plainRes.json()).room;
    createdRooms.push(plainRoom.id);
    check('普通用户可以创建普通房间', !!plainRoom.id);

    const postScreening = async (roomId, token, password) => {
      const res = await fetch(`${BASE}/api/rooms/${roomId}/screening`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(password === undefined ? {} : { password }),
      });
      let body = null;
      try { body = await res.json(); } catch { /* ignore */ }
      return { status: res.status, body };
    };

    // ---- 1. 普通房间没有放映通道 ----
    const notPublic = await postScreening(plainRoom.id, sign(alice), 'x');
    check('普通房间没有放映通道（400）', notPublic.status === 400,
      `status=${notPublic.status} body=${JSON.stringify(notPublic.body)}`);

    // ---- 2. 订单：未设密码时非管理员绝对进不去 ----
    const aliceToken = sign(alice);
    const bobToken = sign(bob);
    const noPass = await postScreening(pubRoom.id, aliceToken, '任意密码');
    check('未设置放映密码时，非管理员无法通过放映通道',
      noPass.status === 403 && noPass.body?.code === 'SCREENING_NO_PASS',
      `status=${noPass.status} code=${noPass.body?.code}`);

    // ---- 3. 管理员免密可进，且不消耗密码 ----
    const adminNoPass = await postScreening(pubRoom.id, adminHeaders.Authorization.replace('Bearer ', ''), undefined);
    check('管理员免密可通过放映通道', adminNoPass.status === 200 && adminNoPass.body?.canScreen === true,
      `status=${adminNoPass.status}`);

    // ---- 4. 管理员设置一次性放映密码 ----
    const setPwd = await fetch(`${BASE}/api/admin/public-rooms/${pubRoom.id}/screening-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ password: 'onetime-777' }),
    });
    check('管理员可设置放映密码', setPwd.ok, `status=${setPwd.status}`);

    // 管理员之前那次免密通过不应消耗密码 → 现在 alice 用密码应能通过
    const aliceClaim = await postScreening(pubRoom.id, aliceToken, 'onetime-777');
    check('管理员进入未消耗一次性密码（alice 仍可用该密码）',
      aliceClaim.status === 200 && aliceClaim.body?.canScreen === true,
      `status=${aliceClaim.status} body=${JSON.stringify(aliceClaim.body)}`);

    // ---- 5. 密码一次性：第二个人用同一密码进不来 ----
    const bobReuse = await postScreening(pubRoom.id, bobToken, 'onetime-777');
    check('放映密码用过即废（bob 复用被拒）',
      bobReuse.status === 403 && bobReuse.body?.code === 'SCREENING_NO_PASS',
      `status=${bobReuse.status} code=${bobReuse.body?.code}`);

    // ---- 6. 房间详情：alice 有放映权限但无解散权 ----
    const detailRes = await fetch(`${BASE}/api/rooms/${pubRoom.id}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const detail = (await detailRes.json()).room;
    check('放映人 canScreen=true', detail.canScreen === true);
    check('放映人 canDissolve=false（不可解散房间）', detail.canDissolve === false,
      `canDissolve=${detail.canDissolve}`);

    const adminDetail = (await (await fetch(`${BASE}/api/rooms/${pubRoom.id}`, { headers: adminHeaders })).json()).room;
    check('管理员 canDissolve=true', adminDetail.canDissolve === true);

    // ---- 7. 放映人可用 host 类操作，但不能解散 ----
    adminSock = await connectSocket(io, BASE, sign(adminUser), { label: '管理员' });
    aliceSock = await connectSocket(io, BASE, sign(alice), { label: '放映人alice' });

    // 与真实前端一致：socket 的 join-room 要求数据库里已有成员行，
    // 前端是先 POST /:id/join 再 emit('join-room')，这里照做。
    const httpJoin = (token) => fetch(`${BASE}/api/rooms/${pubRoom.id}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const aliceJoinRes = await httpJoin(aliceToken);
    check('放映人以普通成员身份加入房间（成员行建立）', aliceJoinRes.ok,
      `status=${aliceJoinRes.status}`);
    await httpJoin(adminHeaders.Authorization.replace('Bearer ', ''));

    const joined = [];
    // 注意：管理员在信令层是「隐身」的（不广播 user-joined、不计入在线名单），
    // 因此这里只能观察到非管理员 alice 的 room-joined。
    aliceSock.on('room-joined', () => joined.push('alice'));
    adminSock.emit('join-room', pubRoom.id);
    aliceSock.emit('join-room', pubRoom.id);
    check('放映人已进入公共房间',
      await waitFor(() => joined.length >= 1, 8000), `joined=${joined.length}`);

    // 放映人执行一次 host 专属操作（设播放源）——应当被接受
    let aliceHostError = null;
    aliceSock.on('error', (e) => { aliceHostError = e?.message || ''; });
    aliceSock.emit('host-set-source', {
      roomId: pubRoom.id, videoUrl: 'https://example.com/a.m3u8', isHls: true,
    });
    await sleep(1000);
    check('放映人可以执行房主类操作（设播放源未被拒）',
      aliceHostError !== '只有房主可以执行该操作',
      `error=${aliceHostError}`);

    // 放映人不能解散房间：HTTP leave 走 canDissolve 判定，房间应当仍存在
    const aliceLeave = await fetch(`${BASE}/api/rooms/${pubRoom.id}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...aliceHeaders },
    });
    const leaveBody = await aliceLeave.json().catch(() => ({}));
    const stillThere = await prisma.room.findUnique({ where: { id: pubRoom.id }, select: { id: true } });
    check('放映人退出不会解散公共房间',
      !!stillThere && leaveBody?.message === '已离开房间',
      `leaveMessage=${leaveBody?.message} roomExists=${!!stillThere}`);

    // ---- 8. 本场结束 → 放映权限作废、通道回到未设密码 ----
    aliceSock.emit('host-screening-end', { roomId: pubRoom.id });
    await sleep(1200);
    const afterEnd = await prisma.room.findUnique({
      where: { id: pubRoom.id },
      select: { screeningPassword: true },
    });
    const hostRows = await prisma.roomScreeningHost.count({ where: { roomId: pubRoom.id } });
    check('本场结束后放映位被清空', hostRows === 0, `rows=${hostRows}`);
    check('本场结束后放映密码处于已作废状态', afterEnd?.screeningPassword === null,
      `pwd=${afterEnd?.screeningPassword}`);

    const afterEndClaim = await postScreening(pubRoom.id, bobToken, 'onetime-777');
    check('本场结束后需管理员重新设密码（旧密码无效）',
      afterEndClaim.status === 403 && afterEndClaim.body?.code === 'SCREENING_NO_PASS',
      `status=${afterEndClaim.status} code=${afterEndClaim.body?.code}`);

    // ---- 9. 掉线宽限：重新设置密码，bob 通过后掉线，宽限期内仍保留权限 ----
    await fetch(`${BASE}/api/admin/public-rooms/${pubRoom.id}/screening-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ password: 'grace-888' }),
    });
    const bobClaim = await postScreening(pubRoom.id, bobToken, 'grace-888');
    check('bob 通过放映通道成为放映人', bobClaim.status === 200, `status=${bobClaim.status}`);

    const bobDetailBefore = (await (await fetch(`${BASE}/api/rooms/${pubRoom.id}`, { headers: { Authorization: `Bearer ${bobToken}` } })).json()).room;
    check('bob 取得放映权限', bobDetailBefore.canScreen === true);

    // bob 掉线（关闭 socket）→ 进入宽限期，权限应保留
    // 同样先建立成员行，否则 join-room 会被「你不在该房间中」拒绝
    await httpJoin(bobToken);
    const bobSock = await connectSocket(io, BASE, bobToken, { label: 'bob' });
    const bobJoined = [];
    bobSock.on('room-joined', () => bobJoined.push(1));
    bobSock.emit('join-room', pubRoom.id);
    await waitFor(() => bobJoined.length >= 1, 6000);
    bobSock.close();
    await waitFor(async () => {
      const row = await prisma.roomScreeningHost.findUnique({ where: { roomId: pubRoom.id } });
      return !!row?.graceUntil;
    }, 8000);

    const bobDetailAfter = (await (await fetch(`${BASE}/api/rooms/${pubRoom.id}`, { headers: { Authorization: `Bearer ${bobToken}` } })).json()).room;
    check('放映人掉线后在宽限期内仍保留放映权限（可刷新回来）',
      bobDetailAfter.canScreen === true, `canScreen=${bobDetailAfter.canScreen}`);

    // ---- 10. 宽限期超时 → 权限释放、密码作废、房间回到 WAITING ----
    await prisma.roomScreeningHost.update({
      where: { roomId: pubRoom.id },
      data: { graceUntil: new Date(Date.now() - 1000) }, // 人为把宽限推到过去
    });
    // 服务端以 graceUntil 判定有效性（不依赖定时器），因此无需等待 reaper
    const bobDetailExpired = (await (await fetch(`${BASE}/api/rooms/${pubRoom.id}`, { headers: { Authorization: `Bearer ${bobToken}` } })).json()).room;
    check('宽限期过后放映权限失效', bobDetailExpired.canScreen === false,
      `canScreen=${bobDetailExpired.canScreen}`);

    // ---- 11. 公共房间不自动消失：所有人都离开后房间仍存在 ----
    adminSock.close();
    aliceSock.close();
    await sleep(1500);
    const survivor = await prisma.room.findUnique({ where: { id: pubRoom.id }, select: { id: true } });
    check('房间内无人时公共房间依然存在（不自动解散）', !!survivor);

    // ---- 12. 清除放映密码后通道对非管理员关闭 ----
    await fetch(`${BASE}/api/admin/public-rooms/${pubRoom.id}/screening-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ password: null }),
    });
    const clearedClaim = await postScreening(pubRoom.id, bobToken, 'anything');
    check('清除放映密码后非管理员无法进入放映通道',
      clearedClaim.status === 403 && clearedClaim.body?.code === 'SCREENING_NO_PASS',
      `status=${clearedClaim.status} code=${clearedClaim.body?.code}`);

    // 管理员即便在没有密码时也能进（需求：管理员是例外）
    const adminStillIn = await postScreening(pubRoom.id, adminHeaders.Authorization.replace('Bearer ', ''), undefined);
    check('未设密码时管理员仍可通过放映通道', adminStillIn.status === 200,
      `status=${adminStillIn.status}`);
  } finally {
    try { adminSock?.close(); } catch { /* ignore */ }
    try { aliceSock?.close(); } catch { /* ignore */ }

    try {
      await prisma.roomScreeningHost.deleteMany({ where: { roomId: { in: createdRooms } } });
      await prisma.roomMember.deleteMany({ where: { roomId: { in: createdRooms } } });
      await prisma.roomBan.deleteMany({ where: { roomId: { in: createdRooms } } });
      await prisma.room.deleteMany({ where: { id: { in: createdRooms } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    } catch (e) {
      console.error('清理测试数据失败:', e.message);
    }
    await prisma.$disconnect();
  }

  report();
  process.exit(checker.counts().fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
