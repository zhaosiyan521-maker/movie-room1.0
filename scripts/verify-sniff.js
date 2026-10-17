/**
 * 本地实测嗅探逻辑（直接 import dist 编译产物里的函数不现实，这里通过起本地服务再打接口验证）。
 * 用法：node scripts/verify-sniff.js
 */
const { BASE, sleep, createChecker } = require('./verify-common');
const checker = createChecker('直链嗅探结果');
const { check, report } = checker;

const URL1 = 'https://55kp8.com/vodplay/558041-7-1.html';
const URL2 = 'https://bpzhe5.com/player/av_Oih8xcOUsNAJWoD4AAquEqf_5wpo0_lNkJFeQ93h5-cjsgvAvU2D69rWnPff22-WMvHvRn3dpqW6LMg?from=%2F';

(async () => {
  console.log('\n========== 直链嗅探 回归 ==========\n');

  const sniff = async (url, label) => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/sniff?url=${encodeURIComponent(url)}`);
    const body = await res.json().catch(() => ({}));
    const ms = Date.now() - t0;
    console.log(`\n[${label}] HTTP ${res.status}，耗时 ${ms}ms`);
    console.log('  title:', JSON.stringify(body.title));
    console.log('  usedBrowser:', body.usedBrowser);
    console.log('  urls 数:', Array.isArray(body.urls) ? body.urls.length : 0);
    if (Array.isArray(body.urls)) {
      for (const u of body.urls) {
        const dur = typeof u.duration === 'number' ? `${Math.round(u.duration / 60)}分${Math.round(u.duration % 60)}秒` : '未知';
        console.log(`   - [${dur}] ${String(u.url).slice(0, 90)}`);
      }
    } else {
      console.log('  body:', JSON.stringify(body).slice(0, 300));
    }
    return { status: res.status, body, ms };
  };

  const r1 = await sniff(URL1, '网址① 55kp8');
  check('网址① 能抓到至少 1 条直链', Array.isArray(r1.body.urls) && r1.body.urls.length > 0,
    `urls=${Array.isArray(r1.body.urls) ? r1.body.urls.length : JSON.stringify(r1.body)}`);
  check('网址① 抓到的是 m3u8 且时长 > 15 分钟',
    Array.isArray(r1.body.urls) && r1.body.urls.some(u => /m3u8/i.test(u.url) && typeof u.duration === 'number' && u.duration >= 900),
    '见上方 url 列表');

  const r2 = await sniff(URL2, '网址② bpzhe5');
  check('网址② 能抓到至少 1 条直链', Array.isArray(r2.body.urls) && r2.body.urls.length > 0,
    `urls=${Array.isArray(r2.body.urls) ? r2.body.urls.length : JSON.stringify(r2.body).slice(0, 200)}`);
  check('网址② 抓到 mp4 且时长 > 15 分钟',
    Array.isArray(r2.body.urls) && r2.body.urls.some(u => /mp4|video/i.test(u.url) && typeof u.duration === 'number' && u.duration >= 900),
    '见上方 url 列表');

  report();
  process.exit(checker.counts().fail > 0 ? 1 : 0);
})().catch(e => { console.error('嗅探测试异常:', e); process.exit(1); });
