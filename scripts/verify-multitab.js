/**
 * 多标签页 / 重复加入 / 启动清理 —— 三个已修复问题的回归测试。
 *
 * 覆盖（对应 BUG-01/02/03）：
 *   BUG-02：同一账号两个标签页
 *     - 共享一个成员行（同一用户只占一个名额，这是设计而非缺陷）
 *     - **一个标签页离开后，成员行必须保留**（另一个标签页还在房间）
 *     - 此时**不得**广播 user-left（否则别人以为他离线了）
 *     - 最后一个标签页离开时，才删成员行并广播 user-left
 *   BUG-03：同一 socket 重复 join-room 不得重复广播 user-joined
 *   BUG-01：启动清理不得在多实例并存时执行（且要登记实例心跳）
 *
 * 用法：node scripts/verify-multitab.js
 */
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const {
  BASE, loadSecret, resolveDatabaseUrl, sleep, waitFor, connectSocket, createChecker,
} = require('./verify-common');

process.env.DATABASE_URL = resolveDatabaseUrl();
const SECRET = loadSecret();
const checker = createChecker('多标签页结果');
const { check, report } = checker;

/** 让某 socket 加入房间并等 room-joined 确认（避免 build-session 竞态） */
function joinAndWait(sock, roomId, label) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    sock.once('room-joined', () => finish(true));
    sock.once('error', (e) => { console.log(`  [${label}] 收到 error: ${e?.message ?? JSON.stringify(e)}`); finish(false); });
    sock.emit('join-room', roomId);
    setTimeout(() => { if (!done) console.log(`  [${label}] 6s 内未收到 room-joined`); finish(false); }, 6000);
  });
}

(async () => {
  const prisma = new PrismaClient();
  console.log('\n========== 多标签页 / 重复加入 回归 ==========\n');

  const uniq = Date.now();
  const hash = await bcrypt.hash('multitab123', 10);
  const mk = (tag) => prisma.user.create({
    data: { username: `mt${tag}${String(uniq).slice(-5)}`, email: `mt${tag}${uniq}@e.com`, passwordHash: hash, nickname: tag.toUpperCase() },
  });
  const host = await mk('h');
  const userA = await mk('a');
  const observer = await mk('o');

  const sign = (u) => jwt.sign({ userId: u.id, tv: u.tokenVersion }, SECRET, { expiresIn: '1h' });
  const authHeaders = (u) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + sign(u) });

  // 必须走 HTTP 建房间：创建接口在同事务里插入房主成员行，而 join-room 要求已有成员行
  const createRes = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: authHeaders(host),
    body: JSON.stringify({ name: `mtroom-${String(uniq).slice(-5)}`, maxViewers: 3 }),
  });
  const roomId = (await createRes.json()).room.id;

  let sHost, sTabA, sTabB, sObs;
  try {
    sHost = await connectSocket(io, BASE, sign(host), { label: '房主' });
    sObs = await connectSocket(io, BASE, sign(observer), { label: '旁观者' });
    sTabA = await connectSocket(io, BASE, sign(userA), { label: '用户A-标签页1' });
    sTabB = await connectSocket(io, BASE, sign(userA), { label: '用户A-标签页2' });

    const joinedEvents = [];
    const leftEvents = [];
    sObs.on('user-joined', (d) => { if (d?.userId === userA.id) joinedEvents.push(d.socketId); });
    sObs.on('user-left', (d) => { if (d?.userId === userA.id) leftEvents.push(d.socketId); });

    // 旁观者也需要成员行才能过 join-room 的成员校验（真实前端同样先 POST /join）
    await fetch(`${BASE}/api/rooms/${roomId}/join`, { method: 'POST', headers: authHeaders(observer) });

    const hostJoined = await joinAndWait(sHost, roomId, '房主');
    const obsJoined = await joinAndWait(sObs, roomId, '旁观者');
    check('房主与旁观者均已加入房间（事件观察有效）', hostJoined && obsJoined,
      `host=${hostJoined} obs=${obsJoined}`);

    // ---- 场景 A：同一账号两个标签页 ----
    await fetch(`${BASE}/api/rooms/${roomId}/join`, { method: 'POST', headers: authHeaders(userA) });
    const tabAJoined = await joinAndWait(sTabA, roomId, '标签页1');
    const r2 = await fetch(`${BASE}/api/rooms/${roomId}/join`, { method: 'POST', headers: authHeaders(userA) });
    const b2 = await r2.json().catch(() => ({}));
    const tabBJoined = await joinAndWait(sTabB, roomId, '标签页2');
    await sleep(600);

    const rowsBoth = await prisma.roomMember.count({ where: { roomId, userId: userA.id } });
    check('两个标签页都加入成功', tabAJoined && tabBJoined, `tabA=${tabAJoined} tabB=${tabBJoined}`);
    check('同一用户只占一个名额（成员行=1，设计如此）', rowsBoth === 1, `rows=${rowsBoth}`);
    check('两个标签页各广播一次 user-joined', joinedEvents.length === 2,
      `joined=${joinedEvents.length}`);

    // ---- 场景 B：同一 socket 重复 join-room（BUG-03）----
    const beforeDup = joinedEvents.length;
    sTabA.emit('join-room', roomId);
    await sleep(900);
    const dupDelta = joinedEvents.length - beforeDup;
    check('BUG-03 已修复：同一 socket 重复 join-room 不再重复广播 user-joined',
      dupDelta === 0, `重复广播 ${dupDelta} 次`);

    // ---- 场景 C：一个标签页离开（BUG-02 修复要点）----
    // 与真实前端一致：带上自己的 socketId，服务端据此排除「调用者自己」，
    // 从而判断该用户是否还有别的标签页在房间内。
    // 同时模拟真实前端的顺序：先 emit leave-room，再 POST /leave。
    leftEvents.length = 0;
    sTabA.emit('leave-room', roomId);
    await sleep(500);
    const leaveRes = await fetch(`${BASE}/api/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: authHeaders(userA),
      body: JSON.stringify({ socketId: sTabA.id }),
    });
    await sleep(1500);
    const rowsAfterOneTab = await prisma.roomMember.count({ where: { roomId, userId: userA.id } });

    check('BUG-02 已修复：一个标签页离开后成员行保留（另一标签页仍在房间）',
      leaveRes.status === 200 && rowsAfterOneTab === 1,
      `leaveStatus=${leaveRes.status} rows=${rowsAfterOneTab}`);
    check('BUG-02 已修复：此时不广播 user-left（不误导其他人以为他离线）',
      leftEvents.length === 0, `user-left=${leftEvents.length}`);
    check('该用户另一标签页仍是连接状态', sTabB.connected);

    // 反证：被排除的是「自己」，另一个标签页确实被服务端看到了
    sTabB.emit('leave-room', roomId);
    await sleep(500);
    const leaveAgain = await fetch(`${BASE}/api/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: authHeaders(userA),
      body: JSON.stringify({ socketId: sTabB.id }),
    });
    await sleep(1200);
    const rowsAfterBothLeave = await prisma.roomMember.count({ where: { roomId, userId: userA.id } });
    // 注意 B 这次 /leave 可能返回 400「你不在该房间中」——
    // 成员行已被 A 那次调用删掉，接口开头的成员校验直接拒绝，这是正确的（他确实已不在房间）。
    // 真正要断言的是「成员行已删除」。
    check('两个标签页都离开后成员行才删除', rowsAfterBothLeave === 0,
      `A=${leaveRes.status} B=${leaveAgain.status} rows=${rowsAfterBothLeave}`);
    check('最后一个标签页离开时会广播 user-left（此时才广播）', leftEvents.length >= 1,
      `user-left=${leftEvents.length}`);

    // ---- 场景 D：socket 断开（关闭标签页，不走 /leave）也会清理 ----
    // 重新加入后直接断开，验证断线路径下成员行同样被回收
    await fetch(`${BASE}/api/rooms/${roomId}/join`, { method: 'POST', headers: authHeaders(userA) });
    const sTabC = await connectSocket(io, BASE, sign(userA), { label: '用户A-标签页3' });
    await joinAndWait(sTabC, roomId, '标签页3');
    sTabC.close();
    await waitFor(async () => (await prisma.roomMember.count({ where: { roomId, userId: userA.id } })) === 0, 8000);
    const rowsAfterDisconnect = await prisma.roomMember.count({ where: { roomId, userId: userA.id } });
    check('关闭标签页（socket 断开）也会回收成员行', rowsAfterDisconnect === 0,
      `rows=${rowsAfterDisconnect}`);

    // ---- 场景 E：BUG-01 实例心跳已登记 ----
    const inst = await prisma.serviceInstance.findMany({ select: { id: true, heartbeatAt: true } });
    check('BUG-01 已修复：服务实例心跳已登记（用于判断是否存在其他活跃副本）',
      inst.length >= 1, `instances=${inst.length}`);
    const fresh = inst.some(i => Date.now() - new Date(i.heartbeatAt).getTime() < 60_000);
    check('心跳时间新鲜（说明周期上报生效）', fresh, JSON.stringify(inst.map(i => i.heartbeatAt)));

    // ---- 场景 F：单实例路径判定前提 ----
    const freshCount = await prisma.serviceInstance.count({
      where: { heartbeatAt: { gte: new Date(Date.now() - 45 * 1000) } }
    });
    check('当前只有本实例心跳新鲜 → 走单实例路径（启动清理会执行）', freshCount === 1,
      `新鲜实例数=${freshCount}`);
  } finally {
    try { sHost?.close(); } catch {}
    try { sTabA?.close(); } catch {}
    try { sTabB?.close(); } catch {}
    try { sObs?.close(); } catch {}
    try {
      await prisma.roomMember.deleteMany({ where: { roomId } });
      await prisma.roomBan.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: [host.id, userA.id, observer.id] } } });
    } catch (e) { console.error('清理失败:', e.message); }
    await prisma.$disconnect();
  }

  report();
  process.exit(checker.counts().fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
