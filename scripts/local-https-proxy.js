/**
 * 本地 HTTPS → 远端 HTTP 反向代理（仅用于自动化验证）。
 *
 * 为什么需要它：麦克风（getUserMedia）只在「安全上下文」（HTTPS 或 localhost）可用。
 * 若被测站点是公网 HTTP（例如 http://<你的服务器IP>:3001），浏览器根本不给
 * navigator.mediaDevices，语音无法开始，也就无从验证。
 * 这里在本机起一个自签名 HTTPS（localhost/127.0.0.2 本身即安全上下文），
 * 把 HTTP 与 WebSocket 全部转发到目标站点，从而在**真实部署的代码**上做语音实测。
 *
 * ⚠️ 安全提示（务必知悉）：
 *   1. 证书是**自签名**的，仅用于本机自动化验证，**不要**拿它对外提供服务；
 *   2. 代理会剥离 Origin / Referer 头（见下方说明），这会绕过目标站点的 CORS 白名单，
 *      **只允许指向你自己的服务**；
 *   3. 配套的实测脚本会设置 NODE_TLS_REJECT_UNAUTHORIZED=0（关闭 TLS 校验），
 *      同样只适用于指向本机反代。
 *
 * 用法：
 *   node scripts/local-https-proxy.js [TARGET_ORIGIN] [PORT] [BIND_ADDRESS]
 *
 * 默认：http://127.0.0.1:3001 → https://127.0.0.2:3001
 * 指向远端示例（页面请用 https://127.0.0.2:3001 访问，勿用 localhost：
 * Node/Chrome 对 localhost 可能优先解析到 ::1，会连不上本代理）：
 *   node scripts/local-https-proxy.js http://<服务器IP>:3001 3001 127.0.0.2
 *
 * 环境变量：
 *   PROXY_TARGET   同第一个位置参数（默认 http://127.0.0.1:3001）
 *   PROXY_DEBUG=1  打印每条转发的状态码；对 >=400 的请求额外打印请求头与响应头
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TARGET = process.argv[2] || process.env.PROXY_TARGET || 'http://127.0.0.1:3001';
const PORT = Number(process.argv[3] || 3001);
const BIND = process.argv[4] || '127.0.0.2';
const target = new URL(TARGET);

// ---------- 生成自签名证书（Node 内置能力，依赖 openssl）----------
function findOpenssl() {
  const { execFileSync } = require('child_process');
  const candidates = [
    'openssl',
    'E:\\Git\\usr\\bin\\openssl.exe',
    'E:\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'
  ];
  for (const c of candidates) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* try next */ }
  }
  throw new Error('找不到 openssl，无法生成自签名证书');
}

function makeCert() {
  const { execFileSync } = require('child_process');
  const openssl = findOpenssl();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-proxy-'));
  const keyPath = path.join(dir, 'key.pem');
  const crtPath = path.join(dir, 'crt.pem');
  execFileSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', crtPath, '-days', '2',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { stdio: 'ignore' });
  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(crtPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return { key, cert };
}

const { key, cert } = makeCert();
console.log(`[proxy] 自签名证书已生成，转发 ${TARGET} → https://localhost:${PORT}`);

// ---------- WebSocket 帧转发（仅需透传，不需要解析帧）----------
const server = https.createServer({ key, cert }, (req, res) => {
  const headers = { ...req.headers, host: target.host };
  // 交给 Node 重新计算：转发原始 content-length 会与实际 body 不一致
  delete headers['accept-encoding'];
  // 浏览器会带上 Origin: https://127.0.0.2:3001，后端 CORS 白名单不含它，
  // 静态资源因此被拒（实测返回 500）。代理对外是同源，直接去掉这两个头。
  delete headers['origin'];
  delete headers['referer'];

  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!hasBody) {
    // GET/HEAD 不能带 body；若把 req 管道进 upstream，Node 会加上
    // transfer-encoding: chunked，后端会把这类「带 body 的 GET」直接判为 500。
    delete headers['content-length'];
    delete headers['transfer-encoding'];
  }

  const opts = {
    hostname: target.hostname,
    port: target.port || 80,
    path: req.url,
    method: req.method,
    headers
  };
  const upstream = http.request(opts, (up) => {
    if (process.env.PROXY_DEBUG) {
      console.log(`[proxy] ${req.method} ${req.url} -> ${up.statusCode}`);
      if (up.statusCode >= 400) {
        console.log('[proxy] 请求头: ' + JSON.stringify(req.headers));
        console.log('[proxy] 响应体: ' + JSON.stringify(up.headers));
      }
    }
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (e) => {
    console.error('[proxy] 上游错误:', e.message);
    try { res.writeHead(502); res.end('proxy error'); } catch { /* ignore */ }
  });
  if (hasBody) req.pipe(upstream);
  else upstream.end();
});

server.on('upgrade', (req, clientSocket, head) => {
  const opts = {
    hostname: target.hostname,
    port: target.port || 80,
    path: req.url,
    method: 'GET',
    headers: {
      ...req.headers,
      host: target.host,
      connection: 'Upgrade',
      upgrade: req.headers.upgrade || 'websocket'
    }
  };
  const upstreamReq = http.request(opts);
  upstreamReq.end();

  upstreamReq.on('upgrade', (upRes, upSocket, upHead) => {
    const headers = Object.entries(upRes.headers)
      .map(([k, v]) => `${k}: ${v}`).join('\r\n');
    clientSocket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`
    );
    if (upHead && upHead.length) upSocket.unshift(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(clientSocket);
    clientSocket.pipe(upSocket);
    const kill = () => { try { upSocket.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
    upSocket.on('error', kill);
    clientSocket.on('error', kill);
    upSocket.on('close', kill);
    clientSocket.on('close', kill);
  });

  upstreamReq.on('error', (e) => {
    console.error('[proxy] WS 上游错误:', e.message);
    try { clientSocket.destroy(); } catch { /* ignore */ }
  });
});

server.listen(PORT, BIND, () => {
  console.log(`[proxy] 就绪: https://${BIND}:${PORT}  (页面须以 https://localhost:${PORT} 访问)`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
