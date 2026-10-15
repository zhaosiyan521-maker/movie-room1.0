/**
 * 语音聊天实机验证脚本（Chrome DevTools Protocol，无需引入 puppeteer）。
 *
 * 目的：实测「麦克风是否真的被释放/是否真的在发声音」，而不是靠读代码下结论。
 * 同时可对比「麦克风音量」设置对上行码率的实际影响。
 *
 * 判定依据（三类客观信号）：
 *   1. getUserMedia 返回的流是否被 stop()（patch 后记录 stop 调用）
 *   2. AudioContext 是否被 close()
 *   3. peer connection 的 outbound-rtp(audio) bytesSent 是否仍在增长
 *      —— 这是「麦克风是否仍在采集并发送」最硬的证据
 *
 * ===== 前置条件 =====
 *   1. 被测站点必须是**安全上下文**（HTTPS 或 localhost），否则浏览器不暴露
 *      navigator.mediaDevices，语音根本无法开始。公网 HTTP 部署请先用
 *      scripts/local-https-proxy.js 起一个本机 HTTPS 反代（见其文件头说明）。
 *   2. 已用 scripts/mint-voice-tokens.js 在**服务端**生成测试账号与令牌，
 *      并把 TOKENS_JSON 存到 .tmp-voice/tokens.json（脚本会优先读它）。
 *      没有该文件时会退化为用用户名密码登录（注意登录接口有限流）。
 *   3. 本机安装了 Chrome。
 *
 * 用法：
 *   node scripts/voice-probe.js [BASE]
 *
 * 可用环境变量：
 *   VOICE_BASE        被测地址（默认 https://127.0.0.2:3001，对应本机 HTTPS 反代）
 *   CHROME_PATH       Chrome 可执行文件（默认 Windows 常见安装路径）
 *   PROBE_CDP_PORT    CDP 端口（默认 9222）
 *   PROBE_HOST_USER / PROBE_VIEWER_USER / PROBE_PASS
 *                     退化到密码登录时使用的测试账号（默认与 mint-voice-tokens.js 一致）
 *   PROBE_KEEP_PROFILE=1  保留 Chrome 用户数据目录（排查用）
 *
 * 安全提示：脚本内对自签名证书关闭了 TLS 校验（NODE_TLS_REJECT_UNAUTHORIZED=0），
 * 仅适用于指向**本机反代**的场景；不要把 BASE 指向你不信任的站点。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || process.env.VOICE_BASE || 'https://127.0.0.2:3001';
// 本机反代使用自签名证书，Node 的 fetch 默认会拒绝；仅用于本机验证。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9222);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA = path.join(__dirname, '..', '.tmp-voice', 'chrome-profile');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(...a) { console.log('[probe]', ...a); }
function fail(msg) { console.error('[FAIL]', msg); process.exitCode = 1; }
function ok(msg) { console.log('[ OK ]', msg); }

async function apiFetch(pathname, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text };
}

/** 注册或登录，返回 token */
async function acquireUser(username, password) {
  const r = await apiFetch('/api/auth/login', { method: 'POST', body: { username, password } });
  if (r.status === 200 && r.json?.token) return { token: r.json.token, how: 'login' };
  throw new Error(`无法登录 ${username}: ${r.status} ${r.text.slice(0, 200)}`);
}

/** 极简 CDP 客户端 */
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error('CDP 连接失败: ' + (e?.message || 'unknown')));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    };
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }
  /** 在页面中求值，返回 JSON 可序列化的值 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** 在页面里安装探针：记录 getUserMedia 流、stop 调用、AudioContext、所有 PeerConnection */
const PROBE_SOURCE = `
(() => {
  const P = { streams: [], stops: [], ctxs: [], pcs: [] };
  window.__voiceProbe = P;

  const gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  if (gum) {
    navigator.mediaDevices.getUserMedia = async function (c) {
      const s = await gum.call(navigator.mediaDevices, c);
      const rec = { id: s.id, tracks: [], stopped: false };
      s.getTracks().forEach(t => {
        rec.tracks.push(t.kind);
        const origStop = t.stop.bind(t);
        t.stop = function () {
          P.stops.push({ streamId: s.id, trackId: t.id, kind: t.kind, at: Date.now() });
          rec.stopped = true;
          return origStop();
        };
      });
      P.streams.push(rec);
      return s;
    };
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    const Patched = function (...a) {
      const ctx = new AC(...a);
      const rec = { state: () => ctx.state, closed: false };
      const origClose = ctx.close.bind(ctx);
      ctx.close = function () {
        rec.closed = true;
        P.ctxs.push({ closed: true, at: Date.now() });
        return origClose();
      };
      P.ctxs.push(rec);
      return ctx;
    };
    Patched.prototype = AC.prototype;
    window.AudioContext = Patched;
    if (window.webkitAudioContext) window.webkitAudioContext = Patched;
  }

  const RPC = window.RTCPeerConnection;
  if (RPC) {
    const PatchedRPC = function (...a) {
      const pc = new RPC(...a);
      P.pcs.push(pc);
      return pc;
    };
    PatchedRPC.prototype = RPC.prototype;
    Object.setPrototypeOf(PatchedRPC, RPC);
    window.RTCPeerConnection = PatchedRPC;
  }
})();
`;

/** 汇总探针状态 + peer connection 出向音频字节数 */
const READ_SOURCE = `
(async () => {
  const P = window.__voiceProbe || { streams: [], stops: [], ctxs: [], pcs: [] };
  let bytesSent = 0, packets = 0, pcCount = 0;
  for (const pc of (P.pcs || [])) {
    pcCount++;
    try {
      const stats = await pc.getStats();
      stats.forEach(r => {
        if (r.type === 'outbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) {
          bytesSent += r.bytesSent || 0;
          packets += r.packetsSent || 0;
        }
      });
    } catch (e) { /* ignore */ }
  }
  return {
    gumCalls: P.streams.length,
    streamStoppedFlags: P.streams.map(s => s.stopped),
    stopCalls: P.stops.length,
    stopKinds: P.stops.map(s => s.kind),
    ctxCount: P.ctxs.length,
    ctxClosed: P.ctxs.filter(c => c.closed).length,
    ctxStates: P.ctxs.filter(c => typeof c.state === 'function').map(c => c.state()),
    pcCount,
    bytesSent,
    packets,
    path: location.pathname,
    inVoiceLabel: document.body.innerText.includes('语音聊天中'),
    joinLabel: document.body.innerText.includes('加入语音聊天')
  };
})()
`;

async function waitFor(label, fn, { timeout = 30000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (e) { last = 'err: ' + e.message; }
    await sleep(interval);
  }
  throw new Error(`等待超时: ${label}（最后状态: ${JSON.stringify(last)}）`);
}

async function main() {
  log('BASE =', BASE);

  // ---------- 1. 测试账号 ----------
  // 优先使用服务器签发的 token（scripts/mint-voice-tokens.js 生成到 .tmp-voice/tokens.json）：
  // 登录接口有 15 分钟限流，反复实测会被 429 挡住。
  const tokenFile = path.join(__dirname, '..', '.tmp-voice', 'tokens.json');
  const suffix = Date.now().toString(36).slice(-4);
  let host, viewer;
  if (fs.existsSync(tokenFile)) {
    const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    host = { token: t.host, how: 'minted' };
    viewer = { token: t.viewer, how: 'minted' };
    log('使用服务器签发的 token（已绕过登录限流）');
  } else {
    // 退化路径：直接用测试账号登录（需先由 mint-voice-tokens.js 建好账号，
    // 且会受登录接口限流影响）。账号名与密码可用环境变量覆盖。
    const hostUser = process.env.PROBE_HOST_USER || 'phvoice1';
    const viewerUser = process.env.PROBE_VIEWER_USER || 'pvvoice1';
    const pass = process.env.PROBE_PASS || 'ProbePass12345';
    host = await acquireUser(hostUser, pass);
    viewer = await acquireUser(viewerUser, pass);
  }
  log(`房主 token(${host.how}) / 观众 token(${viewer.how})`);

  const created = await apiFetch('/api/rooms', {
    method: 'POST',
    token: host.token,
    body: { name: `voice-probe-${suffix}`, maxViewers: 5 }
  });
  const roomId = created.json?.room?.id;
  if (!roomId) throw new Error(`创建房间失败: ${created.status} ${created.text.slice(0, 300)}`);
  log('房间 ID =', roomId);

  // ---------- 2. 启动 Chrome ----------
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  // Chrome 在受限沙箱里启动是概率性成功（crashpad 被杀会自杀退出），因此最多重试 4 次
  let chrome = null;
  let version = null;
  for (let attempt = 1; attempt <= 4 && !version; attempt++) {
    fs.rmSync(USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(USER_DATA, { recursive: true });
    chrome = spawn(CHROME, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--no-default-browser-check',
      // 本机沙箱不允许 Chrome 启动 crashpad 崩溃处理器（OpenProcess 被拒 → 自杀退出），
      // 以下四项用于在受限环境里把 Chrome 跑起来做自动化验证。
      '--disable-crash-reporter',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',       // 自动允许麦克风权限，避免弹窗阻塞
      '--use-fake-device-for-media-stream',   // 虚拟麦克风（产生正弦音）
      '--autoplay-policy=no-user-gesture-required',
      '--ignore-certificate-errors',
      // Chrome 111+ 默认拒绝来自非授权 origin 的 CDP WebSocket 握手（表现为 Page.enable 超时）
      '--remote-allow-origins=*',
      '--unsafely-treat-insecure-origin-as-secure=https://localhost:3001',
      '--host-resolver-rules=MAP localhost 127.0.0.2',
      'about:blank'
    ], { stdio: 'ignore', detached: false });
    log(`Chrome 启动尝试 ${attempt}，pid = ${chrome.pid}`);

    try {
      await waitFor('Chrome 调试端口就绪', async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
          version = await r.json();
          return true;
        } catch { return false; }
      }, { timeout: 20000, interval: 400 });
    } catch (e) {
      log(`第 ${attempt} 次启动失败（${e.message}），重试`);
      try { chrome.kill(); } catch { /* ignore */ }
      await sleep(1500);
    }
  }
  if (!version) throw new Error('Chrome 连续 4 次未能启动调试端口');
  log('Chrome:', version.Browser);

  const newTab = async (url) => {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const t = await r.json();
    const cdp = await new Cdp(t.webSocketDebuggerUrl).connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    openedTabs.push(cdp);
    return { cdp, targetId: t.id };
  };

  const results = {};
  const openedTabs = [];

  try {
    // ---------- 3. 房主：注入 token 与探针 ----------
    const hostTab = await newTab('about:blank');
    await hostTab.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE });
    await hostTab.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('token', ${JSON.stringify(host.token)}); } catch (e) {}`
    });
    await hostTab.cdp.send('Page.navigate', { url: `${BASE}/room/${roomId}` });
    await waitFor('房主页面加载', async () => (await hostTab.cdp.eval('document.readyState')) === 'complete', { timeout: 40000 });
    await sleep(2500);
    const hostDiag = await hostTab.cdp.eval(`JSON.stringify({
      url: location.href,
      title: document.title,
      body: (document.body.innerText || '').slice(0, 600),
      hasJoinVoice: document.body.innerText.includes('加入语音聊天'),
      token: (localStorage.getItem('token') || '').slice(0, 20)
    })`);
    log('房主页面诊断: ' + hostDiag);
    await waitFor('房主看到「加入语音聊天」', async () => hostTab.cdp.eval('document.body.innerText.includes("加入语音聊天")'), { timeout: 40000 });
    ok('房主已进入房间页面');

    // ---------- 4. 观众：注入 token，加入同一房间 ----------
    const viewerTab = await newTab('about:blank');
    await viewerTab.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('token', ${JSON.stringify(viewer.token)}); } catch (e) {}`
    });
    await viewerTab.cdp.send('Page.navigate', { url: `${BASE}/room/${roomId}` });
    await waitFor('观众页面加载', async () => (await viewerTab.cdp.eval('document.readyState')) === 'complete', { timeout: 40000 });
    await sleep(2500);

    // 观众不是房主，进来先看到「加入房间」按钮，需要点一下（房主是房主所以自动进入）
    const viewerJoined = await viewerTab.cdp.eval(`
      (() => {
        if (document.body.innerText.includes('加入语音聊天') || document.body.innerText.includes('语音聊天中')) {
          return 'already-joined';
        }
        const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '加入房间');
        if (!b) return 'no-button';
        b.click();
        return 'clicked';
      })()
    `);
    log('观众加入房间动作: ' + viewerJoined);

    await waitFor('观众看到语音入口', async () => viewerTab.cdp.eval('document.body.innerText.includes("加入语音聊天") || document.body.innerText.includes("语音聊天中")'), { timeout: 40000 });
    await sleep(3000); // 等 peer connection 建立
    ok('观众已进入房间');

    // ---------- 5. 房主点击「加入语音聊天」 ----------
    const clicked = await hostTab.cdp.eval(`
      (() => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find(x => x.innerText.includes('加入语音聊天'));
        if (!b) return 'not-found';
        b.click();
        return 'clicked';
      })()
    `);
    if (clicked !== 'clicked') throw new Error('找不到「加入语音聊天」按钮: ' + clicked);

    await waitFor('房主进入语音状态', async () => {
      const s = await hostTab.cdp.eval(READ_SOURCE);
      return s.gumCalls > 0;
    }, { timeout: 30000 });
    ok('房主已调用 getUserMedia');

    // 等媒体真正开始发送（bytesSent 增长）
    let before = null;
    await waitFor('开始发送音频 RTP', async () => {
      const s = await hostTab.cdp.eval(READ_SOURCE);
      if (s.bytesSent > 0) { before = s; return true; }
      return false;
    }, { timeout: 45000 });
    log('切页前:', JSON.stringify(before));
    ok(`房主麦克风正在发送：bytesSent=${before.bytesSent} packets=${before.packets} pcs=${before.pcCount}`);

    // ---------- 5.5 麦克风音量是否真实生效（对比上行字节速率）----------
    // 判定方式：把「麦克风音量」拉到最小再拉到最大，各测 4 秒的上行字节增量。
    // 增益作用于 WebAudio GainNode（上行），因此低增益应显著减少字节数。
    const measureBytes = async (label, seconds = 4) => {
      const a = await hostTab.cdp.eval(READ_SOURCE);
      await sleep(seconds * 1000);
      const b = await hostTab.cdp.eval(READ_SOURCE);
      return { label, start: a.bytesSent, end: b.bytesSent, delta: b.bytesSent - a.bytesSent };
    };

    // 高音量窗口：必须通过具体滑块（#micVol）驱动，才走真实用户路径
    // （openVoiceSettings 会把音量写进 ref + GainNode，直接改 localStorage 不会生效）
    const setSlider = async (id, value) => hostTab.cdp.eval(`
      (() => {
        const gear = [...document.querySelectorAll('button')].find(x => (x.innerText || '').includes('⚙️'));
        if (gear && !document.querySelector('#micVol')) gear.click();
        const el = document.querySelector('#${id}');
        if (!el) return 'no-slider';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '${value}');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok:' + el.value;
      })()
    `);

    const highSet = await setSlider('micVol', 100);
    log('设置麦克风音量 100% →', highSet);
    const high = await measureBytes('micVolume=100%');

    // 低音量窗口
    const lowSet = await setSlider('micVol', 2);
    log('设置麦克风音量 2% →', lowSet);
    const low = await measureBytes('micVolume=2%');

    log(`麦克风音量 100% 时 4 秒上行 = ${high.delta} 字节`);
    log(`麦克风音量 2%   时 4 秒上行 = ${low.delta} 字节`);
    results.micVolumeHighDelta = high.delta;
    results.micVolumeLowDelta = low.delta;
    results.micVolumeEffective = high.delta > low.delta * 1.5;   // 低增益应明显更小
    ok(`麦克风音量生效 = ${results.micVolumeEffective}（100%:${high.delta} vs 2%:${low.delta}）`);

    // ---------- 6. 房主在 SPA 内切走（点击「房间列表」等导航） ----------
    const nav = await hostTab.cdp.eval(`
      (() => {
        const links = [...document.querySelectorAll('a,button')];
        for (const el of links) {
          const t = (el.innerText || '').trim();
          if (t === '房间列表' || t === '我的房间' || t === '个人中心' || t === '首页') {
            el.click();
            return 'clicked:' + t;
          }
        }
        // 兜底：直接改 hash / 用 history API 让 React Router 切路由
        history.pushState({}, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
        return 'pushstate';
      })()
    `);
    log('切页动作:', nav);
    await waitFor('已离开房间页', async () => {
      const p = await hostTab.cdp.eval('location.pathname');
      return p && !p.startsWith('/room/');
    }, { timeout: 15000 });
    const afterNav = await hostTab.cdp.eval(READ_SOURCE);
    log('切页后（刚离开）:', JSON.stringify(afterNav));
    ok('房主已离开房间页面（path=' + afterNav.path + '）');

    // ---------- 7. 关键判定：麦克风是否仍活着 ----------
    await sleep(6000); // 给 6 秒观察窗口
    const after = await hostTab.cdp.eval(READ_SOURCE);
    log('切页 6 秒后:', JSON.stringify(after));

    results.streamStopCalled = after.stopCalls > 0;
    results.streamStoppedFlag = after.streamStoppedFlags.some(Boolean);
    results.audioCtxClosed = after.ctxClosed > 0;
    results.stillSendingAudio = after.bytesSent > afterNav.bytesSent + 500;
    results.bytesBeforeNav = afterNav.bytesSent;
    results.bytesAfterNav = after.bytesSent;
    results.bytesDelta = after.bytesSent - afterNav.bytesSent;

    console.log('\n================ 实测结论 ================');
    console.log('切页瞬间 bytesSent =', afterNav.bytesSent);
    console.log('切页 6s 后 bytesSent =', after.bytesSent, `(+${results.bytesDelta})`);
    console.log('track.stop() 是否被调用 =', results.streamStopCalled, '(调用次数', after.stopCalls + ')');
    console.log('AudioContext 是否被 close =', results.audioCtxClosed);
    console.log('AudioContext 状态 =', JSON.stringify(after.ctxStates));
    console.log('仍在发送音频 RTP =', results.stillSendingAudio);
    console.log('页面文案：含「语音聊天中」=', after.inVoiceLabel, ' 含「加入语音聊天」=', after.joinLabel);
  } finally {
    // ---------- 8. 清理：关 Chrome ----------
    // 注意：服务端没有 DELETE /rooms/:id 路由，房间只能由房主「解散」或断线宽限期到期后消失。
    // 房主 socket 在这里直接断开，房间会在宽限期后自动解散；另可用
    //   ssh 执行 .tmp-voice/clean-rooms.js 立即清理测试房间。
    for (const t of openedTabs) { try { t.close(); } catch { /* ignore */ } }
    try { chrome.kill(); } catch { /* ignore */ }
    await sleep(800);
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\nRESULT_JSON=' + JSON.stringify(results));
  // 显式退出：CDP 的 WebSocket / Chrome 子进程可能仍持有句柄，否则脚本会挂住不退
  process.exit(process.exitCode || 0);
}

main().catch(e => {
  console.error('\n[ERROR]', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
