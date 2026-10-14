/**
 * Socket 安全回归测试：验证跨房间注入攻击已被拦截（C-4）。
 * 未加入房间的用户不得向任意房间发消息/语音/踢人。
 *
 * 【P5 修复】
 *  1. 连接等待加超时与 connect_error 处理（旧版服务端未启动时会永久挂起）。
 *  2. 「房主 A 已加入房间」不再是字面量 true，而是等待真实的 room-joined 事件；
 *     后续「注入被拦截」的结论只有在 A 确实在房间内时才有意义。
 *  3. 「房主 A 在房间内可正常发言」的 `aGotChat === false || true` 恒真断言改为：
 *     让房间内的第三方 C 实际收到 A 的消息（那才是「正常发言」的定义）。
 *  4. 固定 sleep 改为 waitFor 轮询。
 *  5. 目标地址支持 VERIFY_BASE 覆盖；从任意目录运行。
 */
const path = require('path');
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
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
  console.log('\n========== Socket 跨房间攻击回归 ==========\n');

  // 准备：三个用户 + 一个房间，A（房主）与 C 在房间内，B 不在
  const uniq = Date.now();
  const hash = await require('bcryptjs').hash('sockettest123', 10);

  const userA = await prisma.user.create({
    data: { username: 'sockA' + String(uniq).slice(-6), email: `sa${uniq}@e.com`, passwordHash: hash, nickname: 'A' },
  });
  const userB = await prisma.user.create({
    data: { username: 'sockB' + String(uniq).slice(-6), email: `sb${uniq}@e.com`, passwordHash: hash, nickname: 'B' },
  });
  const userC = await prisma.user.create({
    data: { username: 'sockC' + String(uniq).slice(-6), email: `sc${uniq}@e.com`, passwordHash: hash, nickname: 'C' },
  });

  const room = await prisma.room.create({
    data: { name: 'sockroom' + String(uniq).slice(-6), hostId: userA.id, status: 'WAITING', maxViewers: 5 },
  });
  await prisma.roomMember.create({ data: { roomId: room.id, userId: userA.id, role: 'HOST' } });
  await prisma.roomMember.create({ data: { roomId: room.id, userId: userC.id, role: 'VIEWER' } });

  const sign = (u) => jwt.sign({ userId: u.id, tv: u.tokenVersion }, SECRET, { expiresIn: '1h' });

  let sockA, sockB, sockC;
  try {
    sockA = await connectSocket(io, BASE, sign(userA), { label: '用户A' });
    sockB = await connectSocket(io, BASE, sign(userB), { label: '用户B' });
    sockC = await connectSocket(io, BASE, sign(userC), { label: '用户C' });
    check('三个 Socket 均认证成功', sockA.connected && sockB.connected && sockC.connected);

    // A 与 C 监听房间消息；B 注入的受害者是 C（与 B 不同房间）
    let cGotChatFromB = false, cGotVoiceFromB = false, cGotSpeakingFromB = false;
    let cGotChatFromA = false;
    sockC.on('chat-message', (m) => {
      if (m?.userId === userB.id) cGotChatFromB = true;
      if (m?.userId === userA.id) cGotChatFromA = true;
    });
    sockC.on('voice-state', (d) => { if (d?.userId === userB.id) cGotVoiceFromB = true; });
    sockC.on('user-speaking', (d) => { if (d?.userId === userB.id) cGotSpeakingFromB = true; });

    const aJoinedEvents = [];
    sockA.on('room-joined', (d) => aJoinedEvents.push(d));
    sockC.on('room-joined', (d) => aJoinedEvents.push(d));

    // A 与 C 加入房间
    sockA.emit('join-room', room.id);
    const aJoined = await waitFor(() => aJoinedEvents.length >= 1, 5000);
    check('房主 A 已加入房间（收到 room-joined）', aJoined, `count=${aJoinedEvents.length}`);
    sockC.emit('join-room', room.id);
    check('观众 C 已加入房间', await waitFor(() => aJoinedEvents.length >= 2, 5000),
      `count=${aJoinedEvents.length}`);

    // B（未加入任何房间）尝试向该房间注入
    sockB.emit('chat-message', { roomId: room.id, message: '注入测试消息' });
    sockB.emit('voice-join', room.id);
    sockB.emit('speaking', { roomId: room.id, speaking: true, level: 1 });
    await sleep(1200);

    check('B 未入房向房间内注入聊天被拦截', cGotChatFromB === false, '消息被注入了！');
    check('B 未入房伪造语音状态被拦截', cGotVoiceFromB === false, '语音状态被注入了！');
    check('B 未入房伪造说话状态被拦截', cGotSpeakingFromB === false, '说话状态被注入了！');

    // B 尝试操纵该房间的放映 / 冒充房主踢人
    sockB.emit('kick-user', { roomId: room.id, targetUserId: userA.id });
    await sleep(800);
    const roomAfter = await prisma.room.findUnique({ where: { id: room.id }, select: { status: true } });
    const banExists = await prisma.roomBan.findUnique({
      where: { roomId_userId: { roomId: room.id, userId: userA.id } },
    });
    check('B 场外操纵踢人无效（未产生黑名单）', banExists === null, 'A 被场外用户踢出了！');
    check('房间状态保持不变', roomAfter.status === 'WAITING', `status=${roomAfter.status}`);
    // 注意：此处服务端对「不在房间」是**静默丢弃**（requireInRoom 直接 return），
    // 与其它事件一致，避免向场外用户泄露「该房间是否存在」。因此不应断言会收到 error 回执。
    // 真正的安全属性是「操作未生效」——已由上面两条断言覆盖。
    // 这里只确认 A 的成员关系未被破坏。
    const aStillMember = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: room.id, userId: userA.id } },
    });
    check('A 的成员关系未被场外操作破坏', !!aStillMember);

    // 房间内合法用户 A 的消息应能正常送达 C —— 这才是「可正常发言」的真正断言。
    // 注意：A 的聊天有 3 秒冷却，而 A 之前已发过一条，故先等过冷却窗口再断言，
    // 否则会收到 chat-limited 而非真正的投递（假阴性）。
    cGotChatFromA = false;
    await sleep(3200);
    sockA.emit('chat-message', { roomId: room.id, message: '房主消息' });
    check('房主 A 在房间内发言可正常送达 C',
      await waitFor(() => cGotChatFromA, 5000));
  } finally {
    try { sockA?.close(); } catch { /* ignore */ }
    try { sockB?.close(); } catch { /* ignore */ }
    try { sockC?.close(); } catch { /* ignore */ }

    // 【P5】精确清理：只删本次创建的房间与三个测试用户
    try {
      await prisma.roomBan.deleteMany({ where: { roomId: room.id } });
      await prisma.roomMember.deleteMany({ where: { roomId: room.id } });
      await prisma.room.delete({ where: { id: room.id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id, userC.id] } } });
    } catch (e) {
      console.error('清理测试数据失败:', e.message);
    }
    await prisma.$disconnect();
  }

  report();
  process.exit(checker.counts().fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
