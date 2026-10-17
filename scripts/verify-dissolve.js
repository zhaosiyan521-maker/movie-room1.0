/**
 * 「解散房间」回归测试。
 *
 * 为什么单独建这一份：这个功能曾经静默失效，而既有用例只断言了
 * `POST /leave` 返回 200、没断言「房间是否真的被删除」，所以没能拦住。
 *
 * 最关键的一条是**真实客户端时序**：
 *   1) emit('leave-room')  → 服务端 leaveRoom 先删掉房主的成员行
 *   2) socket 断开
 *   3) POST /leave（带 socketId）→ 此时成员行已不存在
 * 若 /leave 把「不是成员」当幂等提前返回、跳过了 canDissolve，解散就整段失效。
 *
 * 用法：node scripts/verify-dissolve.js
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
const checker = createChecker('解散房间结果');
const { check, report } = checker;

/** 让 socket 加入房间并等 room-joined（避免竞态） */
function joinAndWait(sock, roomId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    sock.once('room-joined', () => finish(true));
    sock.once('error', () => finish(false));
    sock.emit('join-room', roomId);
    setTimeout(() => finish(false), 6000);
  });
}

(async () => {
  const prisma = new PrismaClient();
  console.log('\n========== 解散房间 回归 ==========\n');

  const uniq = Date.now();
  const hash = await bcrypt.hash('dissolve123', 10);
  const mk = (tag) => prisma.user.create({
    data: {
      username: `ds${tag}${String(uniq).slice(-5)}`,
      email: `ds${tag}${uniq}@e.com`,
      passwordHash: hash,
      nickname: `DS${tag}${String(uniq).slice(-5)}`,
    },
  });
  const host = await mk('h');
  const viewer = await mk('v');
  const sign = (u) => jwt.sign({ userId: u.id, tv: u.tokenVersion }, SECRET, { expiresIn: '1h' });
  const H = (u) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + sign(u) });

  const rooms = [];
  const createRoom = async (name) => {
    const res = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: H(host),
      body: JSON.stringify({ name: `${name}-${String(uniq).slice(-5)}`, maxViewers: 10 }),
    });
    const body = await res.json().catch(() => ({}));
    const id = body?.room?.id;
    if (id) rooms.push(id);
    return id;
  };
  const roomExists = async (id) =>
    !!(await prisma.room.findUnique({ where: { id }, select: { id: true } }));

  let sHost = null;
  let sViewer = null;

  try {
    // ---------- 用例 1：真实客户端时序（本回归的主因） ----------
    const roomA = await createRoom('ds-real-seq');
    check('房主可创建房间（用例1）', !!roomA, `id=${roomA}`);

    sHost = await connectSocket(io, BASE, sign(host), { label: '房主' });
    const joined = await joinAndWait(sHost, roomA);
    check('房主已进入房间（成员行存在）', joined, `joined=${joined}`);

    // 复刻 RoomView.leaveRoom 的顺序：先 emit leave-room、再断开、最后 POST /leave
    const hostSocketId = sHost.id;
    sHost.emit('leave-room', roomA);
    await sleep(300);
    sHost.close();
    sHost = null;
    // 等成员行被断开路径删掉（正是旧 bug 的触发条件）
    await waitFor(async () =>
      (await prisma.roomMember.count({ where: { roomId: roomA, userId: host.id } })) === 0, 5000);

    const membersBeforeLeave = await prisma.roomMember.count({ where: { roomId: roomA, userId: host.id } });
    check('前置：POST 之前房主的成员行已被断开路径删除（复现旧 bug 的触发条件）',
      membersBeforeLeave === 0, `rows=${membersBeforeLeave}`);

    const leaveRes = await fetch(`${BASE}/api/rooms/${roomA}/leave`, {
      method: 'POST',
      headers: H(host),
      body: JSON.stringify({ socketId: hostSocketId }),
    });
    const leaveBody = await leaveRes.json().catch(() => ({}));
    const stillThere = await roomExists(roomA);

    // 解散可能发生在 emit('leave-room')（socket 路径，立即生效），
    // 也可能发生在 POST /leave（HTTP 路径）。两者都算成功，
    // 真正要断言的是「房间确实没了」。
    check('真实时序下 /leave 未报错（解散或已离开）',
      leaveRes.status === 200 &&
      (leaveBody?.message === '房间已解散' || leaveBody?.alreadyLeft === true),
      `status=${leaveRes.status} body=${JSON.stringify(leaveBody)}`);
    check('真实时序下房间确实被删除（解散生效）', stillThere === false,
      `roomExists=${stillThere}`);

    // ---------- 用例 1b：房主还有第二个连接在线时点「解散」也必须生效 ----------
    //
    // 真实场景：房主切页会保留一个「持久房主会话 socket」，回到房间页后又有一个标签页 socket。
    // 若解散被「是否最后一个 socket」拦住，就会表现为「点了解散房间没反应」。
    const roomD = await createRoom('ds-two-socks');
    const sPersist = await connectSocket(io, BASE, sign(host), { label: '持久房主会话' });
    await joinAndWait(sPersist, roomD);
    const sTab = await connectSocket(io, BASE, sign(host), { label: '房主标签页' });
    await joinAndWait(sTab, roomD);

    const tabSocketId = sTab.id;
    // 标签页点「解散房间」：emit → 断开 → POST
    sTab.emit('leave-room', roomD);
    await sleep(300);
    sTab.close();
    await sleep(400);
    await fetch(`${BASE}/api/rooms/${roomD}/leave`, {
      method: 'POST',
      headers: H(host),
      body: JSON.stringify({ socketId: tabSocketId }),
    });
    await waitFor(async () => !(await roomExists(roomD)), 6000);
    const twoSockAlive = await roomExists(roomD);
    check('房主另有连接在线时，点「解散房间」仍然解散成功', twoSockAlive === false,
      `roomExists=${twoSockAlive}（true 表示解散被 isLastUserSocket 拦住）`);
    try { sPersist.close(); } catch { /* ignore */ }

    // ---------- 用例 1c：管理员把**公共房间**从房间页点「解散」 ----------
    //
    // 公共房间（管理员创建）的信号层分支**从不自动解散**（设计如此：公共放映厅要一直在）。
    // 所以它只能靠 HTTP /leave 里的 canDissolve 分支解散。
    // 若该分支排在「成员行已删除就提前返回」之后，就会整段被跳过 →
    // 表现正是「点击解散房间没反应，公共房间还在」。
    const adminUser = await prisma.user.create({
      data: {
        username: `dsAdmin${String(uniq).slice(-5)}`,
        email: `dsadmin${uniq}@e.com`,
        passwordHash: hash,
        nickname: `DSADM${String(uniq).slice(-5)}`,
        isAdmin: true,
      },
    });
    try {
      const cr = await fetch(`${BASE}/api/rooms`, {
        method: 'POST',
        headers: H(adminUser),
        body: JSON.stringify({ name: `ds-public-${String(uniq).slice(-5)}`, maxViewers: 10 }),
      });
      const pubId = (await cr.json().catch(() => ({})))?.room?.id;
      rooms.push(pubId);
      check('管理员可创建公共房间（用例1c）', !!pubId, `id=${pubId}`);

      const sPub = await connectSocket(io, BASE, sign(adminUser), { label: '管理员' });
      await joinAndWait(sPub, pubId);
      const pubSocketId = sPub.id;
      sPub.emit('leave-room', pubId);
      await sleep(300);
      sPub.close();
      await sleep(500);

      const pubLeave = await fetch(`${BASE}/api/rooms/${pubId}/leave`, {
        method: 'POST',
        headers: H(adminUser),
        body: JSON.stringify({ socketId: pubSocketId }),
      });
      const pubBody = await pubLeave.json().catch(() => ({}));
      await waitFor(async () => !(await roomExists(pubId)), 5000);
      check('公共房间从房间页点「解散」也能解散成功',
        (await roomExists(pubId)) === false,
        `status=${pubLeave.status} body=${JSON.stringify(pubBody)} roomExists=${await roomExists(pubId)}`);
    } finally {
      await prisma.user.delete({ where: { id: adminUser.id } }).catch(() => {});
    }

    // ---------- 用例 2：房主直接调 /leave（不断 socket） ----------
    const roomB = await createRoom('ds-direct');
    sHost = await connectSocket(io, BASE, sign(host), { label: '房主2' });
    await joinAndWait(sHost, roomB);
    const directRes = await fetch(`${BASE}/api/rooms/${roomB}/leave`, {
      method: 'POST',
      headers: H(host),
      body: JSON.stringify({ socketId: sHost.id }),
    });
    const directBody = await directRes.json().catch(() => ({}));
    check('房主直接 /leave 也解散房间', directBody?.message === '房间已解散',
      `status=${directRes.status} body=${JSON.stringify(directBody)}`);
    check('用例2 房间确实被删除', (await roomExists(roomB)) === false,
      `roomExists=${await roomExists(roomB)}`);

    // ---------- 用例 3：普通观众离开→房间必须保留 ----------
    const roomC = await createRoom('ds-viewer');
    sHost = await connectSocket(io, BASE, sign(host), { label: '房主3' });
    await joinAndWait(sHost, roomC);

    await fetch(`${BASE}/api/rooms/${roomC}/join`, { method: 'POST', headers: H(viewer) });
    sViewer = await connectSocket(io, BASE, sign(viewer), { label: '观众' });
    await joinAndWait(sViewer, roomC);

    const viewerSocketId = sViewer.id;
    sViewer.emit('leave-room', roomC);
    await sleep(300);
    sViewer.close();
    sViewer = null;
    await sleep(500);

    const viewerLeave = await fetch(`${BASE}/api/rooms/${roomC}/leave`, {
      method: 'POST',
      headers: H(viewer),
      body: JSON.stringify({ socketId: viewerSocketId }),
    });
    const viewerBody = await viewerLeave.json().catch(() => ({}));
    check('观众离开返回成功（不报错）',
      viewerLeave.status === 200, `status=${viewerLeave.status} body=${JSON.stringify(viewerBody)}`);
    check('观众离开**不会**解散房间（房间仍在）', (await roomExists(roomC)) === true,
      `roomExists=${await roomExists(roomC)}`);
    check('观众的成员行已删除',
      (await prisma.roomMember.count({ where: { roomId: roomC, userId: viewer.id } })) === 0);
  } finally {
    try { sHost?.close(); } catch { /* ignore */ }
    try { sViewer?.close(); } catch { /* ignore */ }
    await sleep(300);
    try {
      for (const id of rooms) {
        await prisma.roomMember.deleteMany({ where: { roomId: id } });
        await prisma.roomBan.deleteMany({ where: { roomId: id } });
        await prisma.roomScreeningHost.deleteMany({ where: { roomId: id } });
        await prisma.room.delete({ where: { id } }).catch(() => {});
      }
      await prisma.user.deleteMany({ where: { id: { in: [host.id, viewer.id] } } });
    } catch (e) { console.error('清理失败:', e.message); }
    await prisma.$disconnect();
  }

  report();
  process.exit(checker.counts().fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
