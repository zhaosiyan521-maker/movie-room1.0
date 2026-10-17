/**
 * Socket 实时功能回归测试：验证聊天、语音、播放控制、踢人等实时功能可用。
 * 覆盖：双用户进房、互发消息、聊天限流、语音状态、房主播放控制、非房主越权、
 *       房主直接踢人、被踢后禁止再入、房主断线通知。
 *
 * 【P5 修复】
 *  1. 删除了「放映投票」整节 —— 服务端**根本没有** playback-vote-request 事件
 *     （该机制已按需求移除，仅客户端残留），旧版因此恒失败、脚本永远 exit 1。
 *     改为验证真实的 host-pause 路径（房主直接暂停，无需投票）。
 *  2. 删除所有恒真断言（`|| true`、`.length >= 0`、字面量 true）。
 *  3. 「被踢后无法再进入」改为比较踢出前后的计数增量，而不是 `>= 1`（那已经满足）。
 *  4. 清理不再全表 `updateMany({ data: { abruptLeaves: 0 } })`（会宽恕所有真实违规用户），
 *     只重置本次创建的两个测试用户。
 *  5. 连接等待加超时与 connect_error 处理；固定 sleep 改为 waitFor 轮询。
 *  6. 目标地址支持 VERIFY_BASE 覆盖。
 */
const path = require('path');
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const {
  SERVER_DIR, BASE, loadSecret, resolveDatabaseUrl, sleep, waitFor, connectSocket, createChecker,
} = require('./verify-common');

process.env.DATABASE_URL = resolveDatabaseUrl();
const SECRET = loadSecret();
const checker = createChecker('Socket 功能结果');
const { check, skipCheck, report } = checker;

const WATCHED_EVENTS = [
  'user-joined', 'room-joined', 'chat-message', 'chat-limited', 'voice-state', 'user-speaking',
  'playback-start', 'playback-pause', 'playback-resume', 'playback-stop', 'user-left', 'kicked',
  'host-disconnected', 'room-dissolved', 'kick-result', 'error',
];

(async () => {
  const prisma = new PrismaClient();
  console.log('\n========== Socket 实时功能回归 ==========\n');

  const uniq = Date.now();
  const hash = await bcrypt.hash('socktest123', 10);
  const testEmails = ['sockHost@test.local', 'sockViewer@test.local'];

  // 幂等清理：先移除上次运行可能残留的房间（否则会占用房主配额导致建房失败）
  const staleUsers = await prisma.user.findMany({ where: { email: { in: testEmails } }, select: { id: true } });
  if (staleUsers.length) {
    const ids = staleUsers.map((u) => u.id);
    const staleRooms = await prisma.room.findMany({ where: { hostId: { in: ids } }, select: { id: true } });
    for (const r of staleRooms) {
      await prisma.roomBan.deleteMany({ where: { roomId: r.id } });
      await prisma.roomMember.deleteMany({ where: { roomId: r.id } });
      await prisma.room.delete({ where: { id: r.id } }).catch(() => {});
    }
  }

  const userA = await prisma.user.upsert({
    where: { email: 'sockHost@test.local' },
    update: { passwordHash: hash, banned: false, maxRoomsPerIp: 5 },
    create: { username: 'sockHost', email: 'sockHost@test.local', passwordHash: hash, nickname: '房主', maxRoomsPerIp: 5 },
  });
  const userB = await prisma.user.upsert({
    where: { email: 'sockViewer@test.local' },
    update: { passwordHash: hash, banned: false },
    create: { username: 'sockViewer', email: 'sockViewer@test.local', passwordHash: hash, nickname: '观众' },
  });

  const room = await prisma.room.create({
    data: { name: 'sockroom' + String(uniq).slice(-6), hostId: userA.id, status: 'WAITING', maxViewers: 5 },
  });
  await prisma.roomMember.create({ data: { roomId: room.id, userId: userA.id, role: 'HOST' } });
  await prisma.roomMember.create({ data: { roomId: room.id, userId: userB.id, role: 'VIEWER' } });

  const tokenA = jwt.sign({ userId: userA.id, tv: userA.tokenVersion }, SECRET, { expiresIn: '1h' });
  const tokenB = jwt.sign({ userId: userB.id, tv: userB.tokenVersion }, SECRET, { expiresIn: '1h' });

  const events = { A: {}, B: {}, B2: {} };
  function watch(sock, who) {
    WATCHED_EVENTS.forEach((ev) => {
      events[who][ev] = events[who][ev] || [];
      sock.on(ev, (d) => events[who][ev].push(d));
    });
  }

  let sockA, sockB, sockB2;
  try {
    sockA = await connectSocket(io, BASE, tokenA, { label: '用户A' });
    sockB = await connectSocket(io, BASE, tokenB, { label: '用户B' });
    watch(sockA, 'A'); watch(sockB, 'B');

    // ==================== 1. 连接与加入 ====================
    console.log('[1] 连接与加入房间');
    check('用户 A 连接成功', sockA.connected);
    check('用户 B 连接成功', sockB.connected);

    sockA.emit('join-room', room.id);
    const aJoined = await waitFor(() => events.A['room-joined'].length === 1, 5000);
    check('房主 A 加入房间收到 room-joined', aJoined, `count=${events.A['room-joined'].length}`);

    sockB.emit('join-room', room.id);
    const bJoined = await waitFor(() => events.B['room-joined'].length === 1, 5000);
    check('观众 B 加入房间收到 room-joined', bJoined);
    check('A 收到 B 加入通知 user-joined',
      await waitFor(() => events.A['user-joined'].some((d) => d.userId === userB.id), 4000));
    check('B 的用户列表含房主 A',
      events.B['room-joined'][0]?.users?.some((u) => u.userId === userA.id) ?? false,
      JSON.stringify(events.B['room-joined'][0]?.users?.map((u) => u.userId)));

    // ==================== 2. 聊天 ====================
    console.log('\n[2] 实时聊天');
    sockA.emit('chat-message', { roomId: room.id, message: '大家好' });
    check('B 收到 A 的聊天消息',
      await waitFor(() => events.B['chat-message'].some((d) => d.message === '大家好'), 4000),
      `count=${events.B['chat-message'].length}`);
    sockB.emit('chat-message', { roomId: room.id, message: '你好呀' });
    check('A 收到 B 的聊天消息',
      await waitFor(() => events.A['chat-message'].some((d) => d.message === '你好呀'), 4000));

    // 聊天限流：3 秒内连发只应有 1 条到达
    const beforeLimited = events.B['chat-message'].length;
    sockA.emit('chat-message', { roomId: room.id, message: '连续轰炸1' });
    sockA.emit('chat-message', { roomId: room.id, message: '连续轰炸2' });
    sockA.emit('chat-message', { roomId: room.id, message: '连续轰炸3' });
    // 等到第一条（若有）到达，再确认总增量不超过 1
    await waitFor(() => events.B['chat-message'].length > beforeLimited, 3000);
    await sleep(600);
    const burstDelivered = events.B['chat-message'].length - beforeLimited;
    check('聊天限流生效（3 秒内连发只放行 1 条）', burstDelivered <= 1,
      `实际送达=${burstDelivered}`);
    check('限流时向发送方回执 chat-limited',
      await waitFor(() => events.A['chat-limited'].length >= 1, 3000), `count=${events.A['chat-limited'].length}`);

    // ==================== 3. 语音状态 ====================
    console.log('\n[3] 语音状态');
    sockA.emit('voice-join', room.id);
    check('B 收到 A 加入语音',
      await waitFor(() => events.B['voice-state'].some((d) => d.userId === userA.id && d.inVoice === true), 4000));
    sockA.emit('speaking', { roomId: room.id, speaking: true, level: 0.8 });
    check('B 收到 A 说话状态',
      await waitFor(() => events.B['user-speaking'].some((d) => d.userId === userA.id && d.speaking === true), 4000));
    sockA.emit('voice-leave', room.id);
    check('B 收到 A 离开语音',
      await waitFor(() => events.B['voice-state'].some((d) => d.userId === userA.id && d.inVoice === false), 4000));

    // ==================== 4. 播放控制（房主） ====================
    console.log('\n[4] 播放控制');
    sockA.emit('host-start-play', { roomId: room.id, movieName: '测试电影.mp4' });
    check('B 收到开始播放通知',
      await waitFor(() => events.B['playback-start'].some((d) => d.movieName === '测试电影.mp4'), 4000));
    const roomPlaying = await waitFor(async () => {
      const r = await prisma.room.findUnique({ where: { id: room.id }, select: { status: true, currentMovie: true } });
      return r && r.status === 'PLAYING';
    }, 4000) && await prisma.room.findUnique({ where: { id: room.id }, select: { status: true, currentMovie: true } });
    check('数据库状态更新为 PLAYING', roomPlaying.status === 'PLAYING', `status=${roomPlaying.status}`);
    check('数据库记录当前电影', roomPlaying.currentMovie === '测试电影.mp4');

    // 非房主不能控制播放
    const bPlayBefore = events.A['playback-start'].length;
    sockB.emit('host-start-play', { roomId: room.id, movieName: '劫持.mp4' });
    await sleep(700);
    check('非房主发起播放无效（A 未收到劫持播报）',
      events.A['playback-start'].length === bPlayBefore && !events.A['playback-start'].some((d) => d.movieName === '劫持.mp4'));
    check('非房主越权时收到 error 回执', events.B['error'].length >= 1, `count=${events.B['error'].length}`);

    // ==================== 5. 房主直接暂停（原「放映投票」已按需求移除） ====================
    console.log('\n[5] 暂停控制（房主直接操作，无投票机制）');
    const pauseBefore = events.B['playback-pause'].length;
    sockA.emit('host-pause', { roomId: room.id });
    check('房主暂停后 B 收到 playback-pause',
      await waitFor(() => events.B['playback-pause'].length > pauseBefore, 4000),
      `count=${events.B['playback-pause'].length}`);
    const resumeBefore = events.B['playback-resume']?.length || 0;
    sockA.emit('host-resume', { roomId: room.id });
    check('房主恢复后 B 收到 playback-resume',
      await waitFor(() => (events.B['playback-resume']?.length || 0) > resumeBefore, 4000));
    // 非房主不能暂停
    const pauseBeforeB = events.A['playback-pause'].length;
    sockB.emit('host-pause', { roomId: room.id });
    await sleep(700);
    check('非房主发起暂停无效', events.A['playback-pause'].length === pauseBeforeB);

    // ==================== 6. 房主踢人 ====================
    console.log('\n[6] 房主踢人');
    const kickedBefore = events.B['kicked'].length;
    sockA.emit('kick-user', { roomId: room.id, targetUserId: userB.id });
    check('全体收到踢出结果广播',
      await waitFor(() => events.A['kick-result'].some((d) => d.targetUserId === userB.id), 4000));
    check('B 收到被踢通知',
      await waitFor(() => events.B['kicked'].length > kickedBefore, 4000),
      `count=${events.B['kicked'].length}`);
    check('A 收到 B 离开通知',
      await waitFor(() => events.A['user-left'].some((d) => d.userId === userB.id), 4000));
    const banned = await prisma.roomBan.findUnique({ where: { roomId_userId: { roomId: room.id, userId: userB.id } } });
    check('B 被写入房间黑名单', !!banned);

    // 被踢后不能再进：必须比较「再入尝试之后」的计数增量
    const kickedAfterKick = events.B['kicked'].length;
    sockB.emit('join-room', room.id);
    const rejoinRejected = await waitFor(() => events.B['kicked'].length > kickedAfterKick, 4000);
    check('被踢后再次 join-room 被拒（kicked 计数增加）', rejoinRejected,
      `before=${kickedAfterKick} after=${events.B['kicked'].length}`);
    // 且没有收到 room-joined
    const joinedAfterKick = events.B['room-joined'].length;
    await sleep(400);
    check('被踢后未收到 room-joined', events.B['room-joined'].length === joinedAfterKick);

    // ==================== 7. 断线处理 ====================
    console.log('\n[7] 断线处理');
    // 清除黑名单后 B 可重新加入（用真实的 room-joined 事件判断，而不是字面量 true）
    await prisma.roomBan.deleteMany({ where: { roomId: room.id } });
    await prisma.roomMember.upsert({
      where: { roomId_userId: { roomId: room.id, userId: userB.id } },
      create: { roomId: room.id, userId: userB.id, role: 'VIEWER' },
      update: {},
    });
    sockB2 = await connectSocket(io, BASE, tokenB, { label: '用户B2' });
    watch(sockB2, 'B2');
    sockB2.emit('join-room', room.id);
    check('清除黑名单后 B 可重新加入',
      await waitFor(() => events.B2['room-joined'].length >= 1, 5000),
      `count=${events.B2['room-joined'].length}`);

    // 房主断线（放映中）→ 20 秒宽限 → **整间删除**，观众收到 room-dissolved。
    //
    // 【需求变更】旧行为是「宽限后只把房间改回 WAITING 并广播 host-disconnected」，
    // 房间记录会留下来变成「0/30、没人、也没人关」的僵尸房间 —— 本次已改为
    // 宽限到期一律删除房间（不分等待中/放映中），因此断言随之更新。
    await prisma.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    sockA.disconnect();

    // 宽限未到期：房间必须仍在（这 20 秒就是刷新/短暂断网的重连窗口）
    await sleep(10000);
    const stillThere = await prisma.room.findUnique({ where: { id: room.id }, select: { id: true } });
    check('房主断线 10 秒：房间仍存在（20 秒宽限未到期）', !!stillThere);

    const gotDissolved = await waitFor(() => events.B2['room-dissolved'].length >= 1, 20000, 200);
    check('房主断线 20 秒后观众收到 room-dissolved（房间已解散）', gotDissolved,
      `count=${events.B2['room-dissolved'].length}`);

    const roomAfter = await prisma.room.findUnique({ where: { id: room.id }, select: { id: true } });
    check('房主断线 20 秒后房间记录已被彻底删除', roomAfter === null, `room=${roomAfter?.id ?? 'null'}`);
  } finally {
    try { sockA?.close(); } catch { /* ignore */ }
    try { sockB?.close(); } catch { /* ignore */ }
    try { sockB2?.close(); } catch { /* ignore */ }

    // 【P5】精确清理：只删本次创建的房间与两个测试用户；
    // 不再 updateMany({}) 全表重置 abruptLeaves（那会宽恕所有真实违规用户）。
    try {
      await prisma.roomBan.deleteMany({ where: { roomId: room.id } });
      await prisma.roomMember.deleteMany({ where: { roomId: room.id } });
      await prisma.room.delete({ where: { id: room.id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    } catch (e) {
      console.error('清理测试数据失败:', e.message);
    }
    await prisma.$disconnect();
  }

  report();
  process.exit(checker.counts().fail > 0 ? 1 : 0);
})().catch(async (e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
