/**
 * 公共房间 / 普通房间「类型分离 + 解散机制」回归测试。
 *
 * 覆盖两条需求：
 *   1) 房间类型创建时定型：管理员建的一律 PUBLIC，普通用户建的一律 NORMAL，
 *      请求体里写 kind 也无法改变（服务端按账号决定）。
 *   2) 普通房间的解散：
 *      - 房主断开（关标签页/断网/刷新）→ 20 秒宽限 → 到期**不分等待中/放映中**一律删除；
 *      - 宽限期内房主重连 → 取消解散；
 *      - 公共房间房主断开 → 永不解散。
 *
 * 关键回归点：旧实现里「放映中」的普通房间在房主断线后只被改回 WAITING、
 * 房间记录保留，于是留下「0/30、没人、也没人关」的僵尸房间。
 *
 * 用法：node scripts/verify-room-lifecycle.js
 */
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const {
  BASE, loadSecret, resolveDatabaseUrl, sleep, connectSocket, createChecker,
} = require('./verify-common');

process.env.DATABASE_URL = resolveDatabaseUrl();
const SECRET = loadSecret();
const checker = createChecker('房间类型分离与解散结果');
const { check, report } = checker;

/** 让 socket 加入房间并等 room-joined（避免竞态） */
function joinAndWait(sock, roomId, label = 'socket') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    sock.once('room-joined', () => finish(true));
    sock.once('error', (e) => {
      console.log(`  [${label}] 收到 error: ${e?.message ?? JSON.stringify(e)}`);
      finish(false);
    });
    sock.emit('join-room', roomId);
    setTimeout(() => finish(false), 6000);
  });
}

(async () => {
  const prisma = new PrismaClient();
  console.log('\n========== 房间类型分离 / 普通房间解散 ==========\n');

  const uniq = Date.now();
  const tag = String(uniq).slice(-6);
  const hash = await bcrypt.hash('lifecycle123', 10);
  const mk = (name, isAdmin = false) => prisma.user.create({
    data: {
      username: `lc${name}${tag}`,
      email: `lc${name}${tag}@e.com`,
      passwordHash: hash,
      nickname: `LC${name}${tag}`,
      isAdmin,
      // 允许同一个测试账号连开几个房间，避免被普通房间的开房配额拦住
      maxRoomsPerIp: 10,
    },
  });

  const host = await mk('h');
  const admin = await mk('a', true);
  const sign = (u) => jwt.sign({ userId: u.id, tv: u.tokenVersion }, SECRET, { expiresIn: '1h' });
  const H = (u) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + sign(u) });

  const roomIds = [];
  const createRoom = async (user, name, extra = {}) => {
    const res = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: H(user),
      body: JSON.stringify({ name: `${name}-${tag}`, maxViewers: 10, ...extra }),
    });
    const body = await res.json().catch(() => ({}));
    const id = body?.room?.id;
    if (id) roomIds.push(id);
    return { id, status: res.status, body };
  };
  const roomRow = (id) => prisma.room.findUnique({ where: { id }, select: { kind: true, status: true } });
  const roomExists = async (id) => !!(await roomRow(id));

  const sock = (user, label) => connectSocket(io, BASE, sign(user), { label });

  // ── 1. 类型由服务端定型 ───────────────────────────────────────────
  // 普通用户即使传 kind: 'PUBLIC' 也只能建出普通房间
  const normalRoom = await createRoom(host, 'lc-normal', { kind: 'PUBLIC' });
  check('普通用户建房成功', !!normalRoom.id, `status=${normalRoom.status}`);
  const normalKind = normalRoom.id ? (await roomRow(normalRoom.id))?.kind : null;
  check('普通用户建的房间类型 = NORMAL（请求体传 PUBLIC 无效）', normalKind === 'NORMAL', `kind=${normalKind}`);

  // 管理员建的房间一律 PUBLIC（传 kind: 'NORMAL' 也无效）
  const publicRoom = await createRoom(admin, 'lc-public', { kind: 'NORMAL' });
  check('管理员建房成功', !!publicRoom.id, `status=${publicRoom.status} ${JSON.stringify(publicRoom.body?.error || '')}`);
  const publicKind = publicRoom.id ? (await roomRow(publicRoom.id))?.kind : null;
  check('管理员建的房间类型 = PUBLIC（请求体传 NORMAL 无效）', publicKind === 'PUBLIC', `kind=${publicKind}`);

  // ── 2. 普通房间：等待中，房主断开 → 20 秒后删除 ──────────────────
  const waitRoom = await createRoom(host, 'lc-waiting');
  const sWait = waitRoom.id ? await sock(host, 'wait-host') : null;
  if (sWait) await joinAndWait(sWait, waitRoom.id, 'wait-host');

  // ── 3. 普通房间：放映中，房主断开 → 20 秒后删除（本次修复的核心）──
  const playRoom = await createRoom(host, 'lc-playing');
  let sPlay = null;
  if (playRoom.id) {
    const st = await fetch(`${BASE}/api/rooms/${playRoom.id}/status`, {
      method: 'PATCH',
      headers: H(host),
      body: JSON.stringify({ status: 'PLAYING' }),
    });
    check('普通房间可进入放映中状态（供回归用）', st.status === 200, `status=${st.status}`);
    sPlay = await sock(host, 'play-host');
    await joinAndWait(sPlay, playRoom.id, 'play-host');
  }

  // ── 4. 普通房间：宽限期内重连 → 不解散 ───────────────────────────
  const graceRoom = await createRoom(host, 'lc-grace');
  let sGrace = graceRoom.id ? await sock(host, 'grace-host') : null;
  if (sGrace) await joinAndWait(sGrace, graceRoom.id, 'grace-host');

  // ── 5. 公共房间：管理员断开 → 永不解散 ───────────────────────────
  let sPub = null;
  if (publicRoom.id) {
    sPub = await sock(admin, 'pub-host');
    await joinAndWait(sPub, publicRoom.id, 'pub-host');
  }

  // ── 6. 同时断开三个普通房间的房主（计时起点）────────────────────
  sWait?.close();
  sPlay?.close();
  sGrace?.close();
  sPub?.close();
  const t0 = Date.now();
  console.log('  ⏱️  三个普通房间房主已断开，公共房间房主也已断开，开始计时');

  // 宽限期内（第 5 秒）重连 grace 房间。
  // 必须按真实客户端顺序：先 POST /join 重建成员行（断开时行已被删），再 join-room。
  await sleep(5000);
  const rejoinHttp = await fetch(`${BASE}/api/rooms/${graceRoom.id}/join`, {
    method: 'POST',
    headers: H(host),
    body: JSON.stringify({}),
  });
  check('宽限期内 HTTP 可重新加入房间', rejoinHttp.status === 200, `status=${rejoinHttp.status}`);
  const sGrace2 = await sock(host, 'grace-host-2');
  const rejoined = await joinAndWait(sGrace2, graceRoom.id, 'grace-host-2');
  check('宽限期内房主可重新加入房间', rejoined === true);

  // 第 12 秒：宽限未到期，普通房间应仍存在
  await sleep(Math.max(0, 12000 - (Date.now() - t0)));
  check('断开 12 秒：等待中的普通房间仍存在（宽限未到期）', await roomExists(waitRoom.id));
  check('断开 12 秒：放映中的普通房间仍存在（宽限未到期）', await roomExists(playRoom.id));

  // 第 24 秒：宽限已过，两个普通房间必须被彻底删除
  await sleep(Math.max(0, 24000 - (Date.now() - t0)));
  check('断开 24 秒：等待中的普通房间已被删除', !(await roomExists(waitRoom.id)));
  check('断开 24 秒：放映中的普通房间已被删除（旧的僵尸房回归）', !(await roomExists(playRoom.id)));

  if (waitRoom.id) {
    const leftMembers = await prisma.roomMember.count({ where: { roomId: waitRoom.id } });
    check('房间删除时成员记录一并清除', leftMembers === 0, `剩余成员行=${leftMembers}`);
  }
  check('宽限期内重连的房间仍在（未被误解散）', await roomExists(graceRoom.id));
  check('公共房间房主断开后仍然存在（永不解散）', await roomExists(publicRoom.id));

  // ── 清理 ────────────────────────────────────────────────────────
  sGrace2?.close();
  await sleep(300);
  const ids = roomIds.filter(Boolean);
  await prisma.roomMember.deleteMany({ where: { roomId: { in: ids } } });
  await prisma.roomBan.deleteMany({ where: { roomId: { in: ids } } });
  await prisma.roomScreeningHost.deleteMany({ where: { roomId: { in: ids } } });
  await prisma.room.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: [host.id, admin.id] } } });
  await prisma.$disconnect();

  report();
  const { fail } = checker.counts();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  report();
  process.exit(1);
});
