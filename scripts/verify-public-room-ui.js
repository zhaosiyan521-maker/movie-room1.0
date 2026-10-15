/**
 * 端到端验证「公共放映厅」三步弹窗（必须真浏览器：断言的是渲染分支与文案）。
 *
 * 断言：
 *   ① 点卡片 → 弹窗①：房名 + 房主/观众 +「加入房间」「放映通道」「返回列表」三个按钮
 *   ② 点「放映通道」→ 弹窗②：「输入密码」/ 占位「请输入密码」/「请向管理员索要密码」
 *      /「进入放映厅」/「返回列表」
 *   ③ 输对放映密码 → 弹窗③：编辑房间信息表单（名称/描述/图片/密码/人数 + 取消/确认）
 *
 * ===== 前置条件（不满足会直接报错，不会静默跳过）=====
 *   1. 客户端已构建：npm run build:client（脚本从 client/dist 取页面）
 *   2. 本地服务器已启动在 3101 端口，并使用隔离库 ui.db：
 *        $env:DATABASE_URL="file:<ROOT>/ui.db"; $env:PORT=3101
 *        cd server; npx prisma db push --skip-generate; node dist/index.js
 *   3. 本地 HTTPS 代理与 Chrome 由脚本自行拉起（代理 3001 → 3101）
 *
 * 可用环境变量覆盖：CHROME_PATH / UI_TEST_API / UI_TEST_PAGE
 *
 * 运行：node scripts/verify-public-room-ui.js
 *
 * 注意：**刻意不并入 npm run verify** —— 它依赖 Chrome 与本地端口，
 * 属于重量级 UI 回归，按需手动运行。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.join(__dirname, '..');
process.env.DATABASE_URL = 'file:' + path.join(ROOT, 'ui.db').replace(/\\/g, '/');
const prisma = new PrismaClient();

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9250;
const UD = path.join(ROOT, '.tmp-verify', 'chrome-ui');
const PAGE = process.env.UI_TEST_PAGE || 'https://127.0.0.2:3001';
const API = process.env.UI_TEST_API || 'http://127.0.0.1:3101';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const env = fs.readFileSync(path.join(ROOT, 'server', '.env'), 'utf8');
const SECRET = env.match(/JWT_SECRET="?([^"\r\n]+)"?/)[1].trim();
const sign = (u) => jwt.sign({ userId: u.id, tv: u.tokenVersion }, SECRET, { expiresIn: '1h' });

let pass = 0, fail = 0;
const chk = (m, cond, extra = '') => {
  if (cond) { console.log('  ✅ ' + m); pass++; }
  else { console.log('  ❌ ' + m + (extra ? ' → ' + extra : '')); fail++; }
};
const has = (text, s) => (text || '').includes(s);

(async () => {
  const uniq = Date.now();
  const hash = await bcrypt.hash('probe12345', 10);
  const admin = await prisma.user.create({ data: { username: 'uiadm' + String(uniq).slice(-5), email: `uia${uniq}@e.com`, passwordHash: hash, nickname: 'UIA', isAdmin: true, maxRoomsPerIp: 5 } });
  const user = await prisma.user.create({ data: { username: 'uiusr' + String(uniq).slice(-5), email: `uiu${uniq}@e.com`, passwordHash: hash, nickname: 'UIUSER' } });

  let chrome = null, proxy = null, roomId = null;
  try {
    const adminToken = sign(admin);
    const userToken = sign(user);
    const api = async (method, p, token, body) => {
      const res = await fetch(API + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json = null; try { json = await res.json(); } catch { /* ignore */ }
      return { status: res.status, json };
    };

    const roomName = 'UI公共厅' + String(uniq).slice(-4);
    roomId = (await api('POST', '/api/rooms', adminToken, { name: roomName, maxViewers: 20 })).json.room.id;
    await api('POST', `/api/admin/public-rooms/${roomId}/screening-password`, adminToken, { password: 'ui-pass' });
    console.log(`房间：${roomName}`);

    proxy = spawn('node', [path.join(ROOT, 'scripts', 'local-https-proxy.js'), API, '3001', '127.0.0.2'], { stdio: 'ignore', cwd: ROOT });
    await sleep(3500);

    fs.rmSync(UD, { recursive: true, force: true });
    chrome = spawn(CHROME, [
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${UD}`,
      '--no-first-run', '--no-default-browser-check', '--disable-crash-reporter',
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-allow-origins=*',
      '--ignore-certificate-errors', '--unsafely-treat-insecure-origin-as-secure=' + PAGE, 'about:blank'
    ], { stdio: 'ignore' });

    let ver = null;
    for (let i = 0; i < 40; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch { await sleep(500); }
    }
    if (!ver) throw new Error('Chrome 未启动');

    const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp fail')); });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('token', ${JSON.stringify(userToken)});}catch(e){}`
    });

    // ---- 打开大厅 ----
    await send('Page.navigate', { url: `${PAGE}/` });
    await sleep(8000);

    const lobbyText = await evalJs('document.body.innerText');
    chk('大厅已去掉「选择一个房间，与好友一起看电影」',
      !has(lobbyText, '选择一个房间，与好友一起看电影'));

    // ---- 点公共房间卡片 → 弹窗① ----
    const clicked = await evalJs(`
      (() => {
        const cards = [...document.querySelectorAll('.room-card-public')];
        if (!cards.length) return 'no-card';
        cards[0].click();
        return 'ok';
      })()
    `);
    chk('大厅里存在公共房间卡片（.room-card-public）', clicked === 'ok', `click=${clicked}`);
    await sleep(1200);

    const m1 = await evalJs(`JSON.stringify({
      open: !!document.querySelector('.screening-picker'),
      text: (document.querySelector('.screening-picker')?.innerText || ''),
      buttons: [...document.querySelectorAll('.screening-picker button')].map(b => (b.innerText||'').trim())
    })`);
    const m1o = JSON.parse(m1);
    chk('弹窗①已弹出', m1o.open);
    chk('弹窗①显示房名', has(m1o.text, roomName), m1o.text.replace(/\s+/g, ' ').slice(0, 120));
    chk('弹窗①显示房主', has(m1o.text, '房主：'));
    chk('弹窗①显示观众人数', has(m1o.text, '观众：'));
    chk('弹窗①三个按钮：加入房间 / 放映通道 / 返回列表',
      m1o.buttons.includes('加入房间') && m1o.buttons.includes('放映通道') && m1o.buttons.includes('返回列表'),
      `buttons=${JSON.stringify(m1o.buttons)}`);

    // 视觉可用性：弹窗不能透明（真实踩过的坑，见弹窗②处的说明）
    const styleOf = (sel) => evalJs(`
      (() => {
        const el = document.querySelector('${sel}');
        if (!el) return 'null';
        const s = getComputedStyle(el);
        return JSON.stringify({ bg: s.backgroundColor, display: s.display, vis: s.visibility, op: s.opacity });
      })()
    `);
    const opaque = (bg) => {
      if (!bg || bg === 'transparent') return false;
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (!m) return false;
      const parts = m[1].split(',').map(s => s.trim());
      return parts.length < 4 || Number(parts[3]) > 0.95;
    };
    const bgA = JSON.parse(await styleOf('.screening-picker') || 'null');
    chk('弹窗①有不透明背景（不是透明弹窗）', !!bgA && opaque(bgA.bg), `background=${bgA?.bg}`);

    // ---- 点「放映通道」→ 弹窗②（严格按图 2）----
    await evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.screening-picker button')].find(x => (x.innerText||'').trim() === '放映通道');
        if (b) b.click();
        return 'ok';
      })()
    `);
    await sleep(1000);

    const m2 = await evalJs(`JSON.stringify({
      pickerGone: !document.querySelector('.screening-picker'),
      open: !!document.querySelector('.screening-pass-modal'),
      text: (document.querySelector('.screening-pass-modal')?.innerText || ''),
      placeholder: document.querySelector('.screening-passinput')?.placeholder || '',
      buttons: [...document.querySelectorAll('.screening-pass-modal button')].map(b => (b.innerText||'').trim())
    })`);
    const m2o = JSON.parse(m2);
    chk('点「放映通道」后弹窗①自动关闭', m2o.pickerGone);
    chk('弹窗②已弹出', m2o.open);
    chk('弹窗②标题为「输入密码」', has(m2o.text, '输入密码'), m2o.text.replace(/\s+/g, ' '));
    chk('弹窗②占位符为「请输入密码」', m2o.placeholder === '请输入密码', `placeholder=${m2o.placeholder}`);
    chk('弹窗②含「请向管理员索要密码」', has(m2o.text, '请向管理员索要密码'));
    chk('弹窗②按钮为「进入放映厅」与「返回列表」',
      m2o.buttons.includes('进入放映厅') && m2o.buttons.includes('返回列表'),
      `buttons=${JSON.stringify(m2o.buttons)}`);

    // ---- 视觉可用性：弹窗不能是透明的 ----
    // 真实踩过的坑：弹窗只写了 .modal-card 而漏了 .card，于是没有背景色 ——
    // 背景页面透上来、文字压在列表上（手机上尤其明显），而 DOM 断言全部通过。
    // 因此这里显式读取计算样式，要求底色不透明且确实可见。
    const bg2 = JSON.parse(await styleOf('.screening-pass-modal') || 'null');
    chk('弹窗②有不透明背景（不是透明弹窗）', !!bg2 && opaque(bg2.bg),
      `background=${bg2?.bg}`);
    chk('弹窗②是可见的（display/visibility/opacity 正常）',
      !!bg2 && bg2.display !== 'none' && bg2.vis !== 'hidden' && Number(bg2.op) > 0.9,
      JSON.stringify(bg2));

    // ---- 输入密码 → 弹窗③（编辑房间信息）----
    await evalJs(`
      (() => {
        const el = document.querySelector('.screening-passinput');
        if (!el) return 'no-input';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, 'ui-pass');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()
    `);
    await evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.screening-pass-modal button')].find(x => (x.innerText||'').trim() === '进入放映厅');
        if (b) b.click();
        return 'ok';
      })()
    `);
    await sleep(3000);

    const m3 = await evalJs(`JSON.stringify({
      passGone: !document.querySelector('.screening-pass-modal'),
      open: !!document.querySelector('.edit-room-modal'),
      text: (document.querySelector('.edit-room-modal')?.innerText || ''),
      inputs: [...document.querySelectorAll('.edit-room-modal .label')].map(l => (l.innerText||'').trim()),
      buttons: [...document.querySelectorAll('.edit-room-modal button')].map(b => (b.innerText||'').trim()),
      nameValue: document.querySelector('.edit-room-modal input[type="text"]')?.value || ''
    })`);
    const m3o = JSON.parse(m3);
    chk('密码通过后弹窗②关闭', m3o.passGone);
    chk('弹窗③（编辑房间信息）已弹出', m3o.open, m3o.text.replace(/\s+/g, ' ').slice(0, 160));
    if (m3o.open) {
      chk('弹窗③含「房间名称」字段', m3o.inputs.some(t => has(t, '房间名称')), JSON.stringify(m3o.inputs));
      chk('弹窗③含「房间描述」字段', m3o.inputs.some(t => has(t, '房间描述')));
      chk('弹窗③含「房间图片」字段', m3o.inputs.some(t => has(t, '房间图片')));
      chk('弹窗③含「入场密码」字段', m3o.inputs.some(t => has(t, '入场密码')));
      chk('弹窗③含「最大观众数」字段', m3o.inputs.some(t => has(t, '最大观众数')));
      chk('弹窗③按钮为「取消」与「确认」',
        m3o.buttons.includes('确认') && m3o.buttons.includes('取消'),
        `buttons=${JSON.stringify(m3o.buttons)}`);
      chk('弹窗③预填了房间当前名称', m3o.nameValue === roomName, `name=${m3o.nameValue}`);

      // 弹窗③同样不能透明
      const bg3 = JSON.parse(await styleOf('.edit-room-modal') || 'null');
      chk('弹窗③有不透明背景（不是透明弹窗）', !!bg3 && opaque(bg3.bg), `background=${bg3?.bg}`);
    }

    // ---- 发光描边必须真的生效 ----
    // 踩过的坑：`.room-card-public` 与 `.card` 同为单类选择器，而打包后 .card 排在后面，
    // 单类写法会被 .card 完全覆盖 —— 描边样式写了等于没写（computed 仍是 .card 的灰色描边）。
    // 因此这里直接读计算样式，要求描边是设计稿那种亮紫、且带发光阴影。
    const cardStyle = JSON.parse(await evalJs(`
      (() => {
        const el = document.querySelector('.room-card-public');
        if (!el) return 'null';
        const s = getComputedStyle(el);
        return JSON.stringify({ borderColor: s.borderTopColor, boxShadow: s.boxShadow });
      })()
    `) || 'null');
    chk('公共房间卡片有发光描边（描边色已覆盖 .card 的默认色）',
      !!cardStyle && !has(cardStyle.borderColor, '124, 77, 255'),
      `borderColor=${cardStyle?.borderColor}`);
    chk('公共房间卡片带发光阴影（box-shadow 生效）',
      !!cardStyle && has(cardStyle.boxShadow, '168, 110, 255'),
      `boxShadow=${cardStyle?.boxShadow}`);

    // ---- 【新需求】已是放映人时不得再走「加入房间」 ----
    // 服务端会拒绝，因此前端必须提前把该按钮藏掉，否则用户点了只会撞一个错误。
    // 此时用户已在弹窗②那步通过放映通道成为放映人（服务端已记录）。
    // 注意必须**重新加载页面**：大厅列表是进入页面时拉的，
    // 若沿用旧数据，isScreeningHost 还是 false（那是服务端在授予放映权之前返回的）。
    await send('Page.navigate', { url: `${PAGE}/` });
    await sleep(7000);
    await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='先用用看'); if(b)b.click(); return 'ok'; })()`);
    await sleep(800);
    await evalJs(`(() => { const c=document.querySelector('.room-card-public'); if(c)c.click(); return 'ok'; })()`);
    await sleep(1200);
    const afterClaimButtons = JSON.parse(await evalJs(`
      (() => {
        const el = document.querySelector('.screening-picker');
        return JSON.stringify(el ? [...el.querySelectorAll('button')].map(b => (b.innerText||'').trim()) : []);
      })()
    `) || '[]');
    chk('成为放映人后，弹窗里不再出现「加入房间」',
      !afterClaimButtons.includes('加入房间') && afterClaimButtons.includes('放映通道'),
      `buttons=${JSON.stringify(afterClaimButtons)}`);

    try { ws.close(); } catch { /* ignore */ }
  } finally {
    try { proxy?.kill(); } catch { /* ignore */ }
    try { chrome?.kill(); } catch { /* ignore */ }
    await sleep(600);
    try { fs.rmSync(UD, { recursive: true, force: true }); } catch { /* ignore */ }
    if (roomId) {
      await prisma.roomScreeningHost.deleteMany({ where: { roomId } });
      await prisma.roomMember.deleteMany({ where: { roomId } });
      await prisma.roomBan.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, user.id] } } });
    await prisma.$disconnect();
  }

  console.log(`\n三步弹窗 UI 检查：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('UI 实测异常:', e); process.exit(1); });
