/**
 * 验证脚本共用的工具模块。
 *
 * 存在的原因（P5 修复）：五个 verify-*.js 各自复制了断言、连接等待、清理逻辑，
 * 导致同一类缺陷反复出现：
 *   - `await new Promise(r => sock.on('connect', r))` 没有超时与错误处理，
 *     服务端未启动或令牌被拒时脚本**永久挂起**而不是失败；
 *   - 断言里出现 `|| true`、`.length >= 0` 这类恒真表达式；
 *   - 清理用 `deleteMany({})` / `updateMany({})` 作用到全表，会破坏真实数据。
 * 这里统一提供带超时的等待与断言器，以及按本次运行数据精确清理的辅助函数。
 *
 * 位置：必须与其余 verify-*.js 同级（scripts/），因为 SERVER_DIR 相对本文件解析。
 */
const path = require('path');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..', 'server');

/** 目标地址：默认本地 3001，可用 VERIFY_BASE 覆盖以便验证已部署实例 */
const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:3001';

/** 读取服务端 JWT 密钥（供脚本自行签发测试令牌） */
function loadSecret() {
  const env = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
  const m = env.match(/JWT_SECRET="?([^"\r\n]+)"?/);
  return m ? m[1].trim() : null;
}

/**
 * 指向服务端使用的同一个 SQLite 文件。
 * 可用 VERIFY_DB 覆盖为绝对/相对路径——用于「服务端跑在别处的数据库副本上」的场景
 * （例如在只读目录、CI 临时库或隔离环境里验证）。
 */
function databaseUrl() {
  if (process.env.VERIFY_DB) {
    return 'file:' + path.resolve(process.env.VERIFY_DB).replace(/\\/g, '/');
  }
  return 'file:' + path.join(SERVER_DIR, 'prisma', 'dev.db').replace(/\\/g, '/');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等待条件成立，超时返回 false。
 * 用来替代固定的 sleep(500)——固定睡眠在负载高的机器上会得出错误结论
 * （例如「注入被拦截」其实只是消息还没到）。
 */
async function waitFor(cond, timeoutMs = 4000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = await cond(); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

/**
 * 等待 socket 连接，带超时与错误处理。
 * 旧写法在服务端不可达或认证失败时会永久挂起（socket.io 会无限重连），
 * CI 里表现为「卡住」而不是「失败」。
 */
function connectSocket(io, url, token, { timeoutMs = 8000, label = 'socket' } = {}) {
  const sock = io(url, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try { sock.close(); } catch { /* ignore */ }
      reject(new Error(`${label} 连接超时（${timeoutMs}ms）：服务端未启动、地址错误或令牌被拒`));
    }, timeoutMs);
    const onConnect = () => { cleanup(); resolve(sock); };
    const onError = (err) => {
      cleanup();
      try { sock.close(); } catch { /* ignore */ }
      reject(new Error(`${label} 连接失败：${err?.message || '认证失败'}`));
    };
    function cleanup() {
      clearTimeout(timer);
      sock.off('connect', onConnect);
      sock.off('connect_error', onError);
    }
    sock.on('connect', onConnect);
    sock.on('connect_error', onError);
  });
}

/** 断言器：统计通过/失败/跳过，并打印明细 */
function createChecker(title) {
  let pass = 0, fail = 0, skip = 0;
  const issues = [];
  const skips = [];

  function check(name, cond, detail = '') {
    if (cond) { console.log(`  ✅ ${name}`); pass++; }
    else { console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); fail++; issues.push({ name, detail }); }
  }

  /** 跳过：单独计数，**不计入通过**，避免「跳过」被当成「验证成功」 */
  function skipCheck(name, reason = '') {
    console.log(`  ⏭️  ${name}${reason ? '（跳过：' + reason + '）' : '（跳过）'}`);
    skip++; skips.push({ name, reason });
  }

  function report() {
    console.log('\n' + '='.repeat(50));
    console.log(`${title}：通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`);
    if (issues.length) {
      console.log('\n存在问题的功能：');
      issues.forEach((i) => console.log(`  - ${i.name}${i.detail ? '：' + i.detail : ''}`));
    }
    if (skips.length) {
      console.log('\n未执行的检查（不计入通过）：');
      skips.forEach((s) => console.log(`  - ${s.name}${s.reason ? '：' + s.reason : ''}`));
    }
    console.log('='.repeat(50) + '\n');
  }

  return { check, skipCheck, report, counts: () => ({ pass, fail, skip }) };
}

/** 统一 HTTP 辅助（带超时，避免请求悬挂导致脚本卡死） */
async function api(pathname, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + pathname, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    let body = null;
    try { body = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析出本次运行要使用的数据库地址。
 * 优先级：VERIFY_DB（验证脚本专用开关） > 环境里已有的 DATABASE_URL > 默认 dev.db。
 * 之所以让 VERIFY_DB 优先：环境里常常存在 DATABASE_URL=file:./dev.db 这类**相对路径**
 * （服务端 .env 的常见写法），而相对 file: URL 会被 Prisma 相对于 schema 目录解析，
 * 与验证脚本想指向的库未必是同一个，从而出现「服务端与脚本连的不是同一个库」。
 */
function resolveDatabaseUrl() {
  if (process.env.VERIFY_DB) return databaseUrl();
  return process.env.DATABASE_URL || databaseUrl();
}

if (process.env.VERIFY_DEBUG) {
  console.log(`[verify-common] cwd=${process.cwd()}`);
  console.log(`[verify-common] VERIFY_DB=${process.env.VERIFY_DB || '(unset)'}`);
  console.log(`[verify-common] DATABASE_URL(env)=${process.env.DATABASE_URL || '(unset)'}`);
  console.log(`[verify-common] -> using ${resolveDatabaseUrl()}`);
}

module.exports = {
  BASE, SERVER_DIR, loadSecret, databaseUrl, resolveDatabaseUrl, sleep, waitFor,
  connectSocket, createChecker, api,
};
