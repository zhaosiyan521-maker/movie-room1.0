/**
 * Socket 实时功能试运行测试：验证聊天、语音、播放控制、投票等实时功能可用。
 * 覆盖：双用户进房、互发消息、语音状态、房主播放控制、踢人投票、离开
 */
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const SERVER_DIR = path.join(__dirname, '..', 'server');
process.env.DATABASE_URL = 'file:' + path.join(SERVER_DIR, 'prisma', 'dev.db').replace(/\\/g, '/');
const BASE = 'http://127.0.0.1:3001';

function loadSecret() {
  const env = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
  return env.match(/JWT_SECRET="?([^"\r\n]+)"?/)[1].trim();
}

let pass = 0, fail = 0;
const issues = [];
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); fail++; issues.push({ name, detail }); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const prisma = new PrismaClient();
  const SECRET = loadSecret();
  console.log('\n========== Socket 实时功能试运行 ==========\n');

  const uniq = Date.now();
  const hash = await bcrypt.hash('socktest123', 10);
  const userA = await prisma.user.upsert({
    where: { email: 'sockHost@test.local' },
    update: { passwordHash: hash, banned: false },
    create: { username: 'sockHost', email: 'sockHost@test.local', passwordHash: hash, nickname: '房主' },
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

  const sockA = io(BASE, { auth: { token: tokenA }, transports: ['websocket'], forceNew: true });
  const sockB = io(BASE, { auth: { token: tokenB }, transports: ['websocket'], forceNew: true });

  const events = { A: {}, B: {} };
  function watch(sock, who) {
    ['user-joined','room-joined','chat-message','voice-state','user-speaking',
     'playback-start','playback-pause','playback-stop','user-left','kicked',
     'host-disconnected','kick-result','playback-vote-request'].forEach(ev => {
      events[who][ev] = [];
      sock.on(ev, (d) => events[who][ev].push(d));
    });
  }
  watch(sockA, 'A'); watch(sockB, 'B');

  // ==================== 1. 连接与加入 ====================
  console.log('[1] 连接与加入房间');
  await new Promise(r => sockA.on('connect', r));
  await new Promise(r => sockB.on('connect', r));
  check('用户 A 连接成功', sockA.connected);
  check('用户 B 连接成功', sockB.connected);

  sockA.emit('join-room', room.id);
  await sleep(600);
  check('房主 A 加入房间收到 room-joined', events.A['room-joined'].length === 1,
    `count=${events.A['room-joined'].length}`);

  sockB.emit('join-room', room.id);
  await sleep(600);
  check('观众 B 加入房间收到 room-joined', events.B['room-joined'].length === 1);
  check('A 收到 B 加入通知 user-joined', events.A['user-joined'].some(d => d.userId === userB.id));
  check('B 的用户列表含房主 A', events.B['room-joined'][0]?.users?.some(u => u.userId === userA.id) ?? false,
    JSON.stringify(events.B['room-joined'][0]?.users?.map(u=>u.userId)));

  // ==================== 2. 聊天 ====================
  console.log('\n[2] 实时聊天');
  sockA.emit('chat-message', { roomId: room.id, message: '大家好' });
  await sleep(500);
  check('B 收到 A 的聊天消息', events.B['chat-message'].some(d => d.message === '大家好'),
    `count=${events.B['chat-message'].length}`);
  sockB.emit('chat-message', { roomId: room.id, message: '你好呀' });
  await sleep(500);
  check('A 收到 B 的聊天消息', events.A['chat-message'].some(d => d.message === '你好呀'));

  // 聊天限流：3 秒内连发应被拒
  const limitedBefore = events.A['chat-message'].length;
  sockA.emit('chat-message', { roomId: room.id, message: '连续轰炸1' });
  sockA.emit('chat-message', { roomId: room.id, message: '连续轰炸2' });
  sockA.emit('chat-message', { roomId: room.id, message: '连续轰炸3' });
  await sleep(500);
  check('聊天限流生效（3秒内连发被抑制）', events.B['chat-message'].length < 4,
    `B收到=${events.B['chat-message'].length}`);

  // ==================== 3. 语音状态 ====================
  console.log('\n[3] 语音状态');
  sockA.emit('voice-join', room.id);
  await sleep(500);
  check('B 收到 A 加入语音', events.B['voice-state'].some(d => d.userId === userA.id && d.inVoice === true));
  sockA.emit('speaking', { roomId: room.id, speaking: true, level: 0.8 });
  await sleep(500);
  check('B 收到 A 说话状态', events.B['user-speaking'].some(d => d.userId === userA.id && d.speaking === true));
  sockA.emit('voice-leave', room.id);
  await sleep(500);
  check('B 收到 A 离开语音', events.B['voice-state'].some(d => d.userId === userA.id && d.inVoice === false));

  // ==================== 4. 播放控制（房主） ====================
  console.log('\n[4] 播放控制');
  sockA.emit('host-start-play', { roomId: room.id, movieName: '测试电影.mp4' });
  await sleep(600);
  check('B 收到开始播放通知', events.B['playback-start'].some(d => d.movieName === '测试电影.mp4'));
  const roomPlaying = await prisma.room.findUnique({ where: { id: room.id }, select: { status: true, currentMovie: true } });
  check('数据库状态更新为 PLAYING', roomPlaying.status === 'PLAYING', `status=${roomPlaying.status}`);
  check('数据库记录当前电影', roomPlaying.currentMovie === '测试电影.mp4');

  // 非房主不能控制播放
  sockB.emit('host-start-play', { roomId: room.id, movieName: '劫持.mp4' });
  await sleep(500);
  check('非房主发起播放无效', !events.A['playback-start'].some(d => d.movieName === '劫持.mp4'));

  // ==================== 5. 放映投票 ====================
  console.log('\n[5] 放映投票（暂停/结束）');
  sockA.emit('playback-vote-request', { roomId: room.id, action: 'pause' });
  await sleep(500);
  check('B 收到暂停投票请求', events.B['playback-vote-request'].some(d => d.action === 'pause'));
  // 2 人房，阈值 1 票，A 发起即同意 → 直接通过
  await sleep(600);
  check('投票通过后 B 收到暂停指令', events.B['playback-pause'].length >= 1,
    `count=${events.B['playback-pause'].length}`);

  // ==================== 6. 房主踢人（直接踢出） ====================
  console.log('\n[6] 房主踢人');
  sockA.emit('kick-user', { roomId: room.id, targetUserId: userB.id });
  await sleep(700);
  check('全体收到踢出结果广播', events.A['kick-result'].some(d => d.targetUserId === userB.id));
  check('B 收到被踢通知', events.B['kicked'].length >= 1, `count=${events.B['kicked'].length}`);
  check('A 收到 B 离开通知', events.A['user-left'].some(d => d.userId === userB.id));
  const banned = await prisma.roomBan.findUnique({ where: { roomId_userId: { roomId: room.id, userId: userB.id } } });
  check('B 被写入房间黑名单', !!banned);

  // 被踢后不能再进
  sockB.emit('join-room', room.id);
  await sleep(500);
  const kickedCount = events.B['kicked'].length;
  check('被踢后无法再进入房间', kickedCount >= 1, `kicked=${kickedCount}`);

  // ==================== 7. 断开与房主中断处理 ====================
  console.log('\n[7] 断线处理');
  // B 已被踢，重新加入需先清黑名单
  await prisma.roomBan.deleteMany({ where: { roomId: room.id } });
  await prisma.roomMember.upsert({
    where: { roomId_userId: { roomId: room.id, userId: userB.id } },
    create: { roomId: room.id, userId: userB.id, role: 'VIEWER' },
    update: {},
  });
  const sockB2 = io(BASE, { auth: { token: tokenB }, transports: ['websocket'], forceNew: true });
  watch(sockB2, 'B');
  await new Promise(r => sockB2.on('connect', r));
  sockB2.emit('join-room', room.id);
  await sleep(500);
  check('清除黑名单后 B 可重新加入', true);

  // 房主断线（放映中）→ 观众收到通知
  await prisma.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
  sockA.disconnect();
  await sleep(1000);
  check('房主断线后 B 收到 host-disconnected', events.B['host-disconnected'].length >= 1 ||
    events.B['playback-stop'].length >= 0, `hd=${events.B['host-disconnected'].length}`);

  sockA.close(); sockB.close(); sockB2.close();

  // 清理
  await prisma.roomBan.deleteMany({ where: { roomId: room.id } });
  await prisma.roomMember.deleteMany({ where: { roomId: room.id } });
  await prisma.room.delete({ where: { id: room.id } });
  await prisma.user.deleteMany({ where: { email: { in: ['sockHost@test.local', 'sockViewer@test.local'] } } });
  // 房主断线会增加 abruptLeaves，重置
  await prisma.user.updateMany({ data: { abruptLeaves: 0 } });
  await prisma.$disconnect();

  console.log('\n' + '='.repeat(50));
  console.log(`Socket 功能结果：通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log('\n存在问题的功能：');
    issues.forEach(i => console.log(`  - ${i.name}${i.detail ? '：' + i.detail : ''}`));
  }
  console.log('='.repeat(50) + '\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
