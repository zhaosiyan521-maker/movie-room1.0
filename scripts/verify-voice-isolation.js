/**
 * 语音链路专项回归测试（对应本次 V8 加固）。
 *
 * 锁死的不变量：
 *   1. 语音状态（voice-state / user-speaking）**绝不跨房间**投递；
 *   2. `voice-join` 必须是「信令层在该房间」**且**「数据库里是该房间成员」双条件；
 *      仅满足前者（如管理员隐身加入、或将来某个新入口漏了成员行）也不得进入语音；
 *   3. `voice-leave` 只影响自己的语音标记，不误伤他人；
 *   4. 说话上报的服务端限流仍然生效（防止高频事件被放大成 DoS）。
 *
 * 与 verify-socket.js 的区别：那边测的是「未入房用户注入」，
 * 这边测的是「已入房但不同房间」之间的语音串流，以及数据库成员校验这一层加固。
 *
 * 运行：node scripts/verify-voice-isolation.js
 * 可用环境变量：VERIFY_BASE / VERIFY_DB（见 verify-common.js）
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
const checker = createChecker('结果');
const { check, report } = checker;

(async () => {
  const prisma = new PrismaClient();
  console.log('\n========== 语音链路隔离回归 ==========\n');

  const uniq = Date.now();
  const hash = await bcrypt.hash('voicetest123', 10);
  const mk = (tag) => prisma.user.create({
    data: {
      username: `vc${tag}${String(uniq).slice(-6)}`,
      email: `vc${tag}${uniq}@e.com`,
      passwordHash: hash,
      nickname: tag.toUpperCase(),
    },
  });

  // 用户：h1/h2 在房间 1；h3 在房间 2；out 不属于任何房间
  const h1 = await mk('h1');
  const h2 = await mk('h2');
  const h3 = await mk('h3');
  const out = await mk('out');

  const room1 = await prisma.room.create({
    data: { name: `vroom1-${String(uniq).slice(-6)}`, hostId: h1.id, status: 'WAITING', maxViewers: 5 },
  });
  const room2 = await prisma.room.create({
    data: { name: `vroom2-${String(uniq).slice(-6)}`, hostId: h3.id, status: 'WAITING', maxViewers: 5 },
  });
  await prisma.roomMember.create({ data: { roomId: room1.id, userId: h1.id, role: 'HOST' } });
  await prisma.roomMember.create({ data: { roomId: room1.id, userId: h2.id, role: 'VIEWER' } });
  await prisma.roomMember.create({ data: { roomId: room2.id, userId: h3.id, role: 'HOST' } });

  const sign = (u) => jwt.sign({ userId: u.id, tv: u.tokenVersion }, SECRET, { expiresIn: '1h' });

  let s1, s2, s3, sOut;
  try {
    s1 = await connectSocket(io, BASE, sign(h1), { label: '房间1-房主' });
    s2 = await connectSocket(io, BASE, sign(h2), { label: '房间1-观众' });
    s3 = await connectSocket(io, BASE, sign(h3), { label: '房间2-房主' });
    sOut = await connectSocket(io, BASE, sign(out), { label: '无房间用户' });
    check('四个 Socket 均认证成功', s1.connected && s2.connected && s3.connected && sOut.connected);

    // ---- 事件探针 ----
    const seen = {
      s2_voiceFrom1: 0,   // 房间1 观众收到房主语音状态（应当有）
      s2_speakFrom1: 0,   // 房间1 观众收到房主说话（应当有）
      s3_voiceFrom1: 0,   // 房间2 房主收到房间1 的语音状态（绝不该有）
      s3_speakFrom1: 0,   // 房间2 房主收到房间1 的说话（绝不该有）
      sOut_voice: 0,      // 无房间用户收到任何语音状态（绝不该有）
      sOut_speak: 0,
    };
    s2.on('voice-state', (d) => { if (d?.userId === h1.id) seen.s2_voiceFrom1++; });
    s2.on('user-speaking', (d) => { if (d?.userId === h1.id) seen.s2_speakFrom1++; });
    s3.on('voice-state', (d) => { if (d?.userId === h1.id || d?.userId === h2.id) seen.s3_voiceFrom1++; });
    s3.on('user-speaking', (d) => { if (d?.userId === h1.id || d?.userId === h2.id) seen.s3_speakFrom1++; });
    sOut.on('voice-state', () => { seen.sOut_voice++; });
    sOut.on('user-speaking', () => { seen.sOut_speak++; });

    // ---- 各就各位 ----
    const joined = [];
    s1.on('room-joined', () => joined.push('1'));
    s2.on('room-joined', () => joined.push('2'));
    s3.on('room-joined', () => joined.push('3'));
    s1.emit('join-room', room1.id);
    s2.emit('join-room', room1.id);
    s3.emit('join-room', room2.id);
    check('三个用户均已加入各自房间',
      await waitFor(() => joined.length >= 3, 8000), `joined=${joined.length}`);

    // ---- 1. 房间 1 内正常语音应互达 ----
    s1.emit('voice-join', room1.id);
    check('同房间观众收到房主的语音状态',
      await waitFor(() => seen.s2_voiceFrom1 >= 1, 5000), `count=${seen.s2_voiceFrom1}`);

    s1.emit('speaking', { roomId: room1.id, speaking: true, level: 0.8 });
    check('同房间观众收到房主的说话状态',
      await waitFor(() => seen.s2_speakFrom1 >= 1, 5000), `count=${seen.s2_speakFrom1}`);

    // ---- 2. 绝不跨房间 ----
    await sleep(600);
    check('语音状态未串到房间 2', seen.s3_voiceFrom1 === 0, `越界次数=${seen.s3_voiceFrom1}`);
    check('说话状态未串到房间 2', seen.s3_speakFrom1 === 0, `越界次数=${seen.s3_speakFrom1}`);
    check('无房间用户收不到任何语音状态',
      seen.sOut_voice === 0 && seen.sOut_speak === 0,
      `voice=${seen.sOut_voice} speak=${seen.sOut_speak}`);

    // ---- 3. 房间 2 的用户无法用「别人的 roomId」混进房间 1 的语音 ----
    // s3 已加入 room2，requireInRoom 会因 userRooms[s3] !== room1 而拒绝
    s3.emit('voice-join', room1.id);
    s3.emit('speaking', { roomId: room1.id, speaking: true, level: 1 });
    await sleep(700);
    check('房间2 用户借房间1 的 id 加入语音被拦截',
      seen.s2_voiceFrom1 === 1, `房间1 观察到的状态数=${seen.s2_voiceFrom1}（应仍为 1）`);

    // ---- 4. 【V8 加固】数据库成员校验：信令层在房间内、但成员行不存在 → 不得进入语音 ----
    // 人为删除 h1 的成员行（模拟「信令层加入了、但业务上不是成员」的缝隙）
    await prisma.roomMember.deleteMany({ where: { roomId: room1.id, userId: h1.id } });
    const before = seen.s2_voiceFrom1;
    // 先离开语音，确保下一次 join 的状态变化可被观察到
    s1.emit('voice-leave', room1.id);
    await waitFor(() => true, 100); // 让事件排出
    await sleep(500);
    s1.emit('voice-join', room1.id); // 现在应当被成员校验拒绝（静默）
    await sleep(900);
    check('成员行缺失时 voice-join 被拒绝（纵深防御生效）',
      seen.s2_voiceFrom1 === before + 1,
      `状态数=${seen.s2_voiceFrom1}，期望=${before + 1}（+1 是 voice-leave 那次）`);

    // 还原成员行，确认恢复后可再次加入
    await prisma.roomMember.create({ data: { roomId: room1.id, userId: h1.id, role: 'HOST' } });
    const before2 = seen.s2_voiceFrom1;
    s1.emit('voice-join', room1.id);
    check('成员行恢复后 voice-join 重新可用',
      await waitFor(() => seen.s2_voiceFrom1 > before2, 5000),
      `count=${seen.s2_voiceFrom1}`);

    // ---- 5. 说话限流仍然生效（服务端 300ms 最小间隔） ----
    // 连打 20 次，理论上最多通过 ~1 + 间隔内允许的次数；关键断言是「明显少于 20」
    const speakBefore = seen.s2_speakFrom1;
    for (let i = 0; i < 20; i++) {
      s1.emit('speaking', { roomId: room1.id, speaking: true, level: 0.5 });
    }
    await sleep(900);
    const passed = seen.s2_speakFrom1 - speakBefore;
    check('说话上报被限流（20 次连发未全部透传）', passed < 20, `透传=${passed}/20`);
    check('说话上报未全部被丢弃（限流未误杀）', passed >= 1, `透传=${passed}/20`);

    // ---- 6. voice-leave 只影响自己 ----
    const s2Voice = [];
    s1.on('voice-state', (d) => { if (d?.userId === h2.id) s2Voice.push(d.inVoice); });
    s2.emit('voice-join', room1.id);
    await waitFor(() => s2Voice.length >= 1, 5000);
    s2.emit('voice-leave', room1.id);
    await waitFor(() => s2Voice.length >= 2, 5000);
    check('voice-leave 正确广播 inVoice=false', s2Voice[s2Voice.length - 1] === false,
      `序列=${JSON.stringify(s2Voice)}`);
  } finally {
    try { s1?.close(); } catch { /* ignore */ }
    try { s2?.close(); } catch { /* ignore */ }
    try { s3?.close(); } catch { /* ignore */ }
    try { sOut?.close(); } catch { /* ignore */ }

    try {
      await prisma.roomMember.deleteMany({ where: { roomId: { in: [room1.id, room2.id] } } });
      await prisma.roomBan.deleteMany({ where: { roomId: { in: [room1.id, room2.id] } } });
      await prisma.room.deleteMany({ where: { id: { in: [room1.id, room2.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [h1.id, h2.id, h3.id, out.id] } } });
    } catch (e) {
      console.error('清理测试数据失败:', e.message);
    }
    await prisma.$disconnect();
  }

  report();
  process.exit(checker.counts().fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
