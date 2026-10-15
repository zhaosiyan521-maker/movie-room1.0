/**
 * 为语音实测准备账号并签发 JWT（**在服务端执行**）。
 *
 * 为什么不走登录接口：登录接口有 15 分钟 / 次数限制（429），反复实测会被挡住。
 * 这里直接按与 auth.ts 完全一致的方式签发（{ userId, tv } + config.jwtSecret + 7d）。
 *
 * 用法（在服务器的应用目录下）：
 *   scp scripts/mint-voice-tokens.js root@<服务器>:<APP_DIR>/server/mint-voice-tokens.js
 *   cd <APP_DIR>/server && node mint-voice-tokens.js && rm -f mint-voice-tokens.js
 *   # 输出一行 TOKENS_JSON={...}，把它存到本机 .tmp-voice/tokens.json 供 voice-probe.js 使用
 *
 * 注意：config 内部用 dotenv 读取「当前工作目录」下的 .env，**必须**从 server/ 启动；
 * 脚本也要放在 server/ 内，Node 才能按脚本路径解析到 node_modules。
 *
 * 环境变量：
 *   PROBE_HOST_USER / PROBE_VIEWER_USER  测试账号名（默认 phvoice1 / pvvoice1）
 *   PROBE_PASS                           测试账号密码（默认 ProbePass12345）
 * 账号名与密码需与 clean-voice-probe.js 保持一致，否则清理时找不到。
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
// 源码是 TS，服务器上跑的是编译产物；编译后是命名导出 { config }
const config = require('./dist/config').config || require('./dist/config');

const prisma = new PrismaClient();
const HOST_USER = process.env.PROBE_HOST_USER || 'phvoice1';
const VIEWER_USER = process.env.PROBE_VIEWER_USER || 'pvvoice1';
const PASSWORD = process.env.PROBE_PASS || 'ProbePass12345';
const PAIRS = [[HOST_USER, 'Hvoice1'], [VIEWER_USER, 'Vvoice1']];

(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const ids = {};
  for (const [username, nickname] of PAIRS) {
    const email = username + '@probe.local';
    await prisma.emailVerify.upsert({
      where: { email_purpose: { email, purpose: 'register' } },
      update: {},
      create: { email, purpose: 'register' }
    });
    const existing = await prisma.user.findUnique({ where: { username } });
    let user;
    if (existing) {
      user = await prisma.user.update({
        where: { username },
        data: { passwordHash: hash, email, nickname, banned: false, tokenVersion: 0 }
      });
    } else {
      user = await prisma.user.create({ data: { username, email, nickname, passwordHash: hash } });
    }
    ids[username] = { id: user.id, tv: user.tokenVersion };
  }

  const sign = (u) => jwt.sign({ userId: u.id, tv: u.tv }, config.jwtSecret, { expiresIn: '7d' });
  const out = {
    host: sign(ids[HOST_USER]),
    viewer: sign(ids[VIEWER_USER]),
    userIds: { host: ids[HOST_USER].id, viewer: ids[VIEWER_USER].id }
  };
  console.log('TOKENS_JSON=' + JSON.stringify(out));
  await prisma.$disconnect();
  process.exit(0);
})().catch(e => { console.error('MINT_ERROR ' + (e && e.stack ? e.stack : e.message)); process.exit(1); });
