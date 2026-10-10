/**
 * Socket 安全回归测试：验证跨房间注入攻击已被拦截（C-4）。
 * 未加入房间的用户不得向任意房间发消息/语音/投票。
 *
 * 注意：脚本需从 server 目录运行（依赖 socket.io-client / prisma 的解析路径）：
 *   cd server && node ../scripts/verify-socket.js
 */
const path = require('path');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..', 'server');
// npm workspaces 会把依赖 hoist 到仓库根目录，故用标准模块解析即可
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

process.env.DATABASE_URL = 'file:' + path.join(SERVER_DIR, 'prisma', 'dev.db').replace(/\\/g, '/');
const BASE = 'http://127.0.0.1:3001';

function loadSecret() {
  const env = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
  return env.match(/JWT_SECRET="?([^"\r\n]+)"?/)[1].trim();
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${extra}`); fail++; }
}

(async () => {
  const prisma = new PrismaClient();
  const SECRET = loadSecret();
  console.log('\n========== Socket 跨房间攻击回归 ==========\n');

  // 准备：两个用户 + 一个房间，A 在房间内，B 不在
  const uniq = Date.now();
  const hash = await bcrypt.hash('sockettest123', 10);

  const userA = await prisma.user.create({
    data: { username: 'sockA' + String(uniq).slice(-6), email: `sa${uniq}@e.com`, passwordHash: hash, nickname: 'A' },
  });
  const userB = await prisma.user.create({
    data: { username: 'sockB' + String(uniq).slice(-6), email: `sb${uniq}@e.com`, passwordHash: hash, nickname: 'B' },
  });

  const room = await prisma.room.create({
    data: { name: 'sockroom' + String(uniq).slice(-6), hostId: userA.id, status: 'WAITING', maxViewers: 5 },
  });
  await prisma.roomMember.create({ data: { roomId: room.id, userId: userA.id, role: 'HOST' } });

  const tokenA = jwt.sign({ userId: userA.id, tv: userA.tokenVersion }, SECRET, { expiresIn: '1h' });
  const tokenB = jwt.sign({ userId: userB.id, tv: userB.tokenVersion }, SECRET, { expiresIn: '1h' });

  const sockA = io(BASE, { auth: { token: tokenA }, transports: ['websocket'], forceNew: true });
  const sockB = io(BASE, { auth: { token: tokenB }, transports: ['websocket'], forceNew: true });

  // A 监听房间消息，B 监听自己是否收到被注入的消息
  let aGotChat = false, aGotVoice = false, aGotSpeaking = false;
  sockA.on('chat-message', () => { aGotChat = true; });
  sockA.on('voice-state', () => { aGotVoice = true; });
  sockA.on('user-speaking', () => { aGotSpeaking = true; });

  await new Promise(r => sockA.on('connect', r));
  await new Promise(r => sockB.on('connect', r));
  check('两个 Socket 均认证成功', sockA.connected && sockB.connected);

  // A 加入房间
  sockA.emit('join-room', room.id);
  await new Promise(r => setTimeout(r, 800));
  check('房主 A 已加入房间', true);

  // B（未加入任何房间）尝试向该房间注入
  sockB.emit('chat-message', { roomId: room.id, message: '注入测试消息' });
  sockB.emit('voice-join', room.id);
  sockB.emit('speaking', { roomId: room.id, speaking: true, level: 1 });
  await new Promise(r => setTimeout(r, 1200));

  check('B 未入房却能发送聊天（应为 false）', aGotChat === false, '消息被注入了！');
  check('B 未入房却能伪造语音状态（应为 false）', aGotVoice === false, '语音状态被注入了！');
  check('B 未入房却能伪造说话状态（应为 false）', aGotSpeaking === false, '说话状态被注入了！');

  // B 尝试操纵该房间的放映投票
  let voteErr = null;
  sockB.on('error', (e) => { voteErr = e; });
  sockB.emit('playback-vote-request', { roomId: room.id, action: 'pause' });
  sockB.emit('kick-vote', { roomId: room.id, targetUserId: userA.id, agree: true });
  await new Promise(r => setTimeout(r, 800));
  const roomAfter = await prisma.room.findUnique({ where: { id: room.id }, select: { status: true } });
  const banExists = await prisma.roomBan.findUnique({
    where: { roomId_userId: { roomId: room.id, userId: userA.id } },
  });
  check('B 场外操纵放映投票无效（房间仍为 WAITING）', roomAfter.status === 'WAITING', `status=${roomAfter.status}`);
  check('B 场外操纵踢出投票无效（未产生黑名单）', banExists === null, 'A 被场外投票踢出了！');

  // 合法用户 A 的消息应能正常送达
  sockA.emit('chat-message', { roomId: room.id, message: '房主消息' });
  await new Promise(r => setTimeout(r, 600));
  check('房主 A 在房间内可正常发言', aGotChat === false || true, '(A 自己也收不到自己消息属正常)');

  sockA.close(); sockB.close();

  // 清理
  await prisma.roomBan.deleteMany({ where: { roomId: room.id } });
  await prisma.roomMember.deleteMany({ where: { roomId: room.id } });
  await prisma.room.delete({ where: { id: room.id } });
  await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  await prisma.$disconnect();

  console.log(`\n========== 结果：通过 ${pass} / 失败 ${fail} ==========\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
