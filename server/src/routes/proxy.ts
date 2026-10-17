import express, { Router, Response } from 'express';
import dns from 'dns';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Agent, WebSocket as UndiciWebSocket } from 'undici';

export const proxyRouter = Router();

/**
 * 关键修复：禁用 Node 原生 fetch 对系统代理（HTTP_PROXY/HTTPS_PROXY）的自动读取。
 *
 * Node 18+ 的全局 fetch（undici）会读取 HTTP_PROXY / HTTPS_PROXY 环境变量，
 * 若用户机器配置了系统代理（国内科学上网等场景很常见），视频抓取请求会被代理劫持，
 * 导致直链抓取失败（"upstream connect failed"）或流式传输变慢/中断，
 * 表现就是"网络直链播放总是加载失败"。
 *
 * 这里显式构造一个不读环境变量、不走任何代理的 undici Agent，让视频直链直连源站。
 */
const dispatcher = new Agent({ connect: { timeout: 30_000 } });

/**
 * 网络视频直链代理。
 *
 * 背景：TikTok / 抖音 / 部分 CDN 的直链在浏览器地址栏能直接播放，
 * 但一旦放进 <video src> 由页面发起请求，浏览器会带上
 *   Referer: http://localhost:5173/ 与 Origin，
 * 多数视频 CDN 据此做防盗链校验并直接拒绝（表现就是 onError → "视频加载失败"）。
 *
 * 解决：客户端改为请求同源的 /api/video-proxy?url=...，由服务端去抓取视频，
 * 再以同源响应流回给 <video>。服务端抓取时**不带**跨站 Referer，而是带上
 * 目标站点的同源 Referer（等同"浏览器地址栏直开"时子请求携带的 Referer），
 * 因此能绕过防盗链；同时彻底规避跨域限制。
 *
 * HLS 特殊处理：.m3u8 是播放列表，内部引用大量 .ts 分片 / 嵌套 .m3u8 / 密钥。
 * 若只代理顶层清单，HLS.js 拉子分片时会因相对路径 404 或直接回源跨域而致命失败。
 * 因此代理会解析清单，把所有 URI 改写成仍走本代理的绝对地址，确保分片也同源。
 *
 * 安全（SSRF 防护）：仅允许 http/https；拒绝带凭据的链接；拒绝 localhost / *.local；
 * 解析主机后若指向内网/回环地址则拒绝，避免被当作内网代理滥用。
 */

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === '::1' || ip === '0.0.0.0') return true;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // IPv6 链路本地 (fe80::/10) 与唯一本地地址 (fc00::/7)
  if (/^(fe80|fc|fd)/i.test(ip)) return true;
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

async function hostResolvesPrivate(hostname: string): Promise<boolean> {
  try {
    const { address } = await dns.promises.lookup(hostname);
    return isPrivateIp(address);
  } catch {
    // 解析失败：宁可拒绝，避免被用于探测内网
    return true;
  }
}

const PASS_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
];

/** 判断响应是否为 HLS 播放列表（.m3u8 路径 或 对应 content-type） */
function isHlsPlaylist(pathname: string, contentType: string | null): boolean {
  if (/\.m3u8(\?|$)/i.test(pathname)) return true;
  if (contentType && /mpegurl|x-mpegurl|vnd\.apple\.mpegurl/i.test(contentType)) return true;
  return false;
}

/**
 * 重写 HLS 播放列表：把清单中所有 URI（分片、嵌套清单、密钥、初始化片段）
 * 解析为绝对地址后，改写成仍走本代理的 /api/video-proxy?url=... 形式。
 * 这样 HLS.js / 原生 HLS 拉取每个分片都会经过同源代理，彻底规避跨域。
 *
 * @param body   原始清单文本
 * @param base   清单所在目录的绝对 URL（用于解析相对路径）
 */
export function rewriteHlsManifest(body: string, base: URL): string {
  // 不是 HLS 文本则原样返回，避免误伤
  if (!/#EXT/i.test(body)) return body;

  const lines = body.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      out.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      // 标签行：若含 URI="..."（如 EXT-X-KEY / EXT-X-MAP / EXT-X-I-FRAME-STREAM-INF）则重写其值
      if (trimmed.includes('URI=')) {
        const rewritten = trimmed.replace(/URI="([^"]*)"/g, (_m, uri: string) => {
          const proxied = proxyUri(uri, base);
          return proxied ? `URI="${proxied}"` : `URI="${uri}"`;
        });
        out.push(rewritten);
      } else {
        out.push(line);
      }
      continue;
    }

    // 裸 URI 行（分片或嵌套播放列表）
    const proxied = proxyUri(trimmed, base);
    out.push(proxied || line);
  }

  return out.join('\n');
}

/** 把单个 URI 解析为绝对地址并改写成代理地址；非 http(s) 返回 null（保持原样） */
function proxyUri(uri: string, base: URL): string | null {
  if (/^[a-z0-9+.-]+:/i.test(uri) && !/^https?:/i.test(uri)) {
    // 非 http(s) 协议（data: 等）保持原样
    return null;
  }
  let abs: string;
  try {
    abs = new URL(uri, base).toString();
  } catch {
    return null;
  }
  if (!/^https?:/i.test(abs)) return null;
  return `/api/video-proxy?url=${encodeURIComponent(abs)}`;
}

proxyRouter.get('/video-proxy', async (req, res: Response) => {
  const raw = req.query.url;
  if (typeof raw !== 'string' || !raw) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }
  if (!isHttpUrl(raw)) {
    return res.status(400).json({ error: '仅支持 http/https 直链' });
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).json({ error: '链接格式无效' });
  }

  // 拒绝带用户名/密码的链接，避免被用于注入凭据
  if (parsed.username || parsed.password) {
    return res.status(400).json({ error: '不支持带凭据的链接' });
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return res.status(400).json({ error: '禁止访问本地/内网主机' });
  }

  if (await hostResolvesPrivate(host)) {
    return res.status(400).json({ error: '禁止访问内网地址' });
  }

  // 服务端抓取时：浏览器类 UA + 目标站同源 Referer（等同地址栏直开时子请求携带的 Referer）。
  // 不带跨站 Referer/Origin，因此能绕过多数防盗链校验。
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Accept: '*/*',
    Referer: parsed.origin + '/',
  };
  // 透传 Range 请求，支持 <video> 拖拽进度/跳播
  const clientRange = req.headers.range;
  if (typeof clientRange === 'string') headers.Range = clientRange;

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(parsed.toString(), {
      method: 'GET',
      headers,
      redirect: 'follow',
      // 关键：显式传入不读环境变量的 dispatcher，绕过系统代理劫持
      dispatcher,
    } as any);
  } catch (err) {
    console.error('[video-proxy] 抓取失败:', (err as Error)?.message);
    return res.status(502).json({ error: '无法获取目标视频' });
  }

  // 仅放行成功响应（含 206 分段）
  if (!upstream.ok && upstream.status !== 206) {
    return res.status(upstream.status || 502).json({ error: `上游返回 ${upstream.status}` });
  }

  const contentType = upstream.headers.get('content-type');

  // ---- HLS 播放列表：重写后再返回 ----
  if (isHlsPlaylist(parsed.pathname, contentType)) {
    const text = await upstream.text();
    const base = new URL('.', parsed); // 清单所在目录，用于解析相对路径
    const rewritten = rewriteHlsManifest(text, base);
    const buf = Buffer.from(rewritten, 'utf-8');
    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    return res.end(buf);
  }

  // ---- 其余媒体：原样流式转发 ----
  res.status(upstream.status);
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  // 同源媒体请求，额外放开 CORS（无害）
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'public, max-age=300');
  }

  if (!upstream.body) {
    return res.end();
  }

  try {
    const nodeStream = Readable.fromWeb(upstream.body as any);
    await pipeline(nodeStream, res);
  } catch (err) {
    console.error('[video-proxy] 流式传输中断:', (err as Error)?.message);
    // 客户端连接可能已断开（aborted），此处无需再写响应
    if (!res.headersSent) {
      res.status(502).end();
    }
  }
});

// =====================================================================
// 以下是直链嗅探（sniff）相关代码。
// 分两档：
//   1) 轻量抓取：抓 HTML → 反解 JS 转义 → 提取媒体 URL → 递归抓 iframe。
//      覆盖「直链明文写在页面源码 / iframe 子页源码里」的资源站（如网址①）。
//   2) 无头浏览器兜底：真实浏览器执行 JS，拦截网络请求，覆盖「直链由 JS 运行时
//      动态请求产生」的 SPA（如网址②）。
// 时长分析在两种结果之上统一执行：能拿到时长的打标签，并把 >15 分钟的排前。
// =====================================================================

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 媒体类型判定：对齐油猴脚本的 isMedia 思路，覆盖 HLS / DASH / 分片 / 常见直链 */
function isMediaUrl(url: string): boolean {
  if (!url) return false;
  const u = String(url);
  const ul = u.toLowerCase();

  // 拒绝明显是代码碎片/伪 URL 的噪声（含 JS 语句字符、模板、超长拼接等）
  if (/[\s;{}()<>`=]/.test(u)) return false;

  // 明确媒体扩展名 → 一定是媒体（但排除 .d.ts 类型声明文件）
  if (/\.d\.ts(\?|$)/i.test(ul)) return false;
  if (/\.(m3u8?|mp4|flv|mpd|mkv|m4s|ts|webm|mov|avi)(\?|$)/i.test(ul)) return true;

  // 排除明显的静态资源与网页资源（含 .d.ts 类型声明）
  if (/\.(html?|js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map|d\.ts)(\?|$)/i.test(ul)) return false;

  // 无后缀但命中这些「强媒体特征」的（如 CDN 直链 / 解析站接口）才判为疑似媒体。
  // 注意：不能只用 hls/stream/video/play 这种宽关键字，否则 JS 源码里的
  // /player/hlsError、/player/jsm3u8 这类资源名都会被误判（bpzhe5 实测中招）。
  if (/onewsvod|byteimg|m3u8|video_mp4|mime_type=video|\.vod|playurl|video\/tos|hls\//i.test(ul)) return true;

  return false;
}

/** 反解 JS 字符串里常见的转义，让藏起来的 URL 能被后续正则命中 */
function unescapeJsText(input: string): string {
  let s = input;
  // \uXXXX 反解（含 \u002F / \u003A 等；中文路径也靠它还原）
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => {
    try {
      return String.fromCharCode(parseInt(hex, 16));
    } catch {
      return _m;
    }
  });
  // \xXX 反解
  s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    try {
      return String.fromCharCode(parseInt(hex, 16));
    } catch {
      return _m;
    }
  });
  // 常见转义斜杠 / 冒号
  s = s.replace(/\\\//g, '/');
  s = s.replace(/\\u002f/gi, '/');
  s = s.replace(/\\u003a/gi, ':');
  s = s.replace(/\\x2f/gi, '/');
  s = s.replace(/\\x3a/gi, ':');
  return s;
}

/** 把某段文本里所有「疑似媒体 URL」抽出来（绝对地址；相对路径交给调用方用 base 解析） */
function extractFromText(text: string, base: URL, out: Set<string>): void {
  const t = unescapeJsText(text);

  // 绝对 URL（含查询串），去掉末尾可能的引号/逗号/反斜杠等噪声。
  // 用 isMediaUrl 二次校验，而不是只认固定扩展名，从而覆盖无后缀的 CDN 直链。
  const absRe = /https?:\/\/[^\s"'<>\\]+/gi;
  for (const m of t.match(absRe) || []) {
    const cleaned = m.replace(/[\\'",;)\]}>]+$/, '');
    if (cleaned && isMediaUrl(cleaned)) {
      try {
        const p = new URL(cleaned);
        if (p.protocol === 'http:' || p.protocol === 'https:') out.add(p.toString());
      } catch { /* ignore */ }
    }
  }

  // 引号包裹的路径形式（相对或裸路径），用 base 解析。
  // 注意：只在「引号内容以明确媒体扩展名结尾」时才处理 ——
  // 相对路径不像绝对 URL 那样能靠 isMediaUrl 的关键字启发式可靠判断，
  // 否则会把 `/player/hlsError`、`/player/jsm3u8` 这类 JS 源码里的资源名
  // 拼成一大堆伪链（bpzhe5 就中过招）。
  const relRe = /(?:"|')([^"']+)(?:"|')/g;
  let mm: RegExpExecArray | null;
  while ((mm = relRe.exec(t))) {
    const candidate = mm[1];
    if (/\s/.test(candidate)) continue;
    // 相对路径只认「明确媒体扩展名」结尾的
    if (!/\.(m3u8?|mp4|flv|mpd|mkv|m4s|ts|webm|mov|avi)(\?|$)/i.test(candidate)) continue;
    try {
      const abs = new URL(candidate, base);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') out.add(abs.toString());
    } catch { /* ignore */ }
  }
}

/** 从 HTML 里提取 iframe 的绝对地址（跨域套壳播放器是抓不到直链的最常见原因） */
function extractIframes(html: string, base: URL): string[] {
  const out: string[] = [];
  const re = /<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const abs = new URL(m[1], base);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') out.push(abs.toString());
    } catch { /* ignore */ }
  }
  return Array.from(new Set(out));
}

interface FetchPageResult {
  ok: boolean;
  status?: number;
  html?: string;
  finalUrl?: string;
}

/** 抓取页面 HTML（与 /sniff 共用同一套 SSRF 校验与 dispatcher） */
async function fetchPageHtml(url: string): Promise<FetchPageResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false };
  }
  if (parsed.username || parsed.password) return { ok: false };
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false };
  if (await hostResolvesPrivate(host)) return { ok: false };

  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: parsed.origin + '/',
  };

  try {
    const upstream = await fetch(parsed.toString(), {
      method: 'GET',
      headers,
      redirect: 'follow',
      dispatcher,
    } as any);
    if (!upstream.ok) return { ok: false, status: upstream.status };
    const html = await upstream.text();
    return { ok: true, html, finalUrl: upstream.url };
  } catch {
    return { ok: false };
  }
}

/** 轻量嗅探：主页面 + 递归 iframe，返回去重后的媒体 URL 集合 */
async function sniffLightweight(startUrl: string): Promise<{ urls: string[]; title: string }> {
  const found = new Set<string>();
  let title = '';
  const visited = new Set<string>();

  const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
  const maxIframeDepth = 2;      // 最多递归两层 iframe，防止失控
  const maxIframePages = 6;      // 最多额外抓取 6 个 iframe 子页

  while (queue.length > 0) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const page = await fetchPageHtml(url);
    if (!page.ok || !page.html) continue;

    const base = new URL(page.finalUrl || url);

    if (!title) {
      const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(page.html);
      if (titleMatch) title = titleMatch[1].trim();
    }

    // 从本页抽取媒体直链
    extractFromText(page.html, base, found);

    // 递归抓 iframe（仅当还没抓满时）
    if (depth < maxIframeDepth && found.size === 0 && visited.size <= maxIframePages) {
      for (const iframeUrl of extractIframes(page.html, base)) {
        if (visited.has(iframeUrl) || visited.size > maxIframePages) continue;
        queue.push({ url: iframeUrl, depth: depth + 1 });
      }
    }
  }

  return { urls: Array.from(found), title };
}

/**
 * 时长分析：对每条直链尽力拿到时长（秒），拿不到的返回 null。
 * - m3u8：拉清单，累加 #EXTINF（同时解析主清单里的多清晰度子清单，取最长那档）
 * - mp4/其它：用 Range 拉文件头解析 mvhd/moov（失败则回退用 bitrate 粗估）
 */
async function probeDuration(url: string): Promise<number | null> {
  try {
    const isHls = /\.m3u8(\?|$)/i.test(new URL(url).pathname) || /m3u8/i.test(url);
    if (isHls) {
      const d = await probeHlsDuration(url);
      if (d != null) return d;
    }
    // 非 HLS 或 HLS 解析失败：尝试 mp4 头解析
    const d = await probeMp4Duration(url);
    return d;
  } catch {
    return null;
  }
}

async function probeHlsDuration(url: string): Promise<number | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const headers = { 'User-Agent': BROWSER_UA, Accept: '*/*', Referer: parsed.origin + '/' };
  const upstream = await fetch(parsed.toString(), { method: 'GET', headers, redirect: 'follow', dispatcher } as any);
  if (!upstream.ok) return null;
  const text = await upstream.text();

  // 主清单（含 #EXT-X-STREAM-INF 多清晰度）→ 递归取每个子清单，返回最长时长
  const hasVariants = /#EXT-X-STREAM-INF/i.test(text);
  if (hasVariants) {
    let best: number | null = null;
    const uriRe = /^(?!#)(\S+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = uriRe.exec(text))) {
      const sub = new URL(m[1], parsed).toString();
      const d = await probeHlsDuration(sub);
      if (d != null && (best == null || d > best)) best = d;
    }
    return best;
  }

  // 普通清单：累加 EXTINF
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const mm = /^#EXTINF:([\d.]+)/.exec(line.trim());
    if (mm) total += parseFloat(mm[1]);
  }
  return total > 0 ? Math.round(total) : null;
}

/** 解析 MP4 头里的 mvhd/mdhd 时长（毫秒 → 秒）；失败返回 null */
async function probeMp4Duration(url: string): Promise<number | null> {
  try {
    const parsed = new URL(url);
    const headers = {
      'User-Agent': BROWSER_UA,
      Accept: '*/*',
      Referer: parsed.origin + '/',
      Range: 'bytes=0-1048575', // 前 1MB，通常已覆盖 moov
    };
    const upstream = await fetch(parsed.toString(), { method: 'GET', headers, redirect: 'follow', dispatcher } as any);
    if (!upstream.ok && upstream.status !== 206) return null;
    const buf = Buffer.from(await upstream.arrayBuffer());

    // 找 mvhd box：'mvhd' + version(1B) + flags(3B)，时长在 version 之后
    const mvhd = findBox(buf, 'mvhd');
    if (mvhd) {
      const version = mvhd[0];
      if (version === 1) {
        // 64 位时长（秒 × timescale，双字大端）—— 简化处理：直接读 duration
        const duration = buf.readBigUInt64BE(mvhd.byteOffset + 16);
        const timescale = buf.readUInt32BE(mvhd.byteOffset + 20);
        if (timescale > 0) return Math.round(Number(duration) / timescale);
      } else {
        const timescale = buf.readUInt32BE(mvhd.byteOffset + 12);
        const duration = buf.readUInt32BE(mvhd.byteOffset + 16);
        if (timescale > 0 && duration > 0) return Math.round(duration / timescale);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 在 Buffer 中查找指定 box type（简单线性查找，够用于前 1MB 的 moov） */
function findBox(buf: Buffer, type: string): Buffer | null {
  const needle = Buffer.from(type, 'latin1');
  let offset = 0;
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset);
    const t = buf.toString('latin1', offset + 4, offset + 8);
    if (size < 8) size = 8;
    if (t === type) {
      // 返回 box 内容（不含 8 字节头）
      return buf.subarray(offset + 8, Math.min(offset + size, buf.length));
    }
    offset += size;
  }
  return null;
}

// =====================================================================
// 无头浏览器兜底：SPA 页面只有执行 JS 后才会发起媒体请求，
// 服务端抓 HTML 拿不到。这里用 CDP 起一个真实浏览器拦截网络请求。
// 实现上不硬依赖 puppeteer：直接走 Chrome 的 --remote-debugging-port + CDP。
// =====================================================================

interface BrowserSniffResult {
  urls: string[];
  title: string;
  usedBrowser: boolean;
}

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter((p): p is string => !!p);

let chromePath: string | null = null;
let chromeChecked = false;

function resolveChromePath(): string | null {
  if (chromeChecked) return chromePath;
  chromeChecked = true;
  const fs = require('fs');
  for (const p of CHROME_PATHS) {
    if (p && fs.existsSync(p)) {
      chromePath = p;
      break;
    }
  }
  return chromePath;
}

/**
 * 用无头浏览器打开页面，拦截一段时间内的媒体请求与**响应体**，返回命中的媒体直链。
 *
 * 很多 SPA（如网址②）的直链并不出现在「媒体请求」里，而是藏在 XHR/fetch 的
 * JSON 响应体中（例：`/v1/playback/resolve` 返回 line_options[].url 的 m3u8/mp4）。
 * 因此这里除了拦截 `Network.requestWillBeSent`，还拦截 `Network.loadingFinished` 后
 * 调 `Network.getResponseBody` 读响应体，从 JSON 里再抽一遍媒体 URL。
 */
async function sniffWithBrowser(startUrl: string): Promise<BrowserSniffResult> {
  const ch = resolveChromePath();
  if (!ch) {
    return { urls: [], title: '', usedBrowser: false };
  }

  const { spawn } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const port = 9300 + Math.floor(Math.random() * 500);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniff-chrome-'));
  const foundUrls = new Set<string>();
  const seenRequestIds = new Set<string>();
  let title = '';

  const chrome = spawn(ch, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--remote-allow-origins=*',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  const timeout = 30_000;
  const deadline = Date.now() + timeout;

  try {
    // 等 CDP 就绪
    let wsUrl: string | null = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        const j = (await res.json()) as { webSocketDebuggerUrl?: string };
        wsUrl = j.webSocketDebuggerUrl || null;
        if (wsUrl) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!wsUrl) return { urls: [], title: '', usedBrowser: true };

    // 建立 CDP 会话
    const targetsRes = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(startUrl)}`, { method: 'PUT' });
    const target = (await targetsRes.json()) as { webSocketDebuggerUrl?: string };
    if (!target.webSocketDebuggerUrl) return { urls: [], title: '', usedBrowser: true };

    // 注意：Node 20 没有全局 WebSocket（本地用 Node 24 开发没暴露这个问题，
    // 部署到服务器的 Node 20 后 sniffWithBrowser 直接 ReferenceError）。
    // 这里用 undici 的 WebSocket（项目已有该依赖），不额外引入 ws。
    // 关键：undici WebSocket 用 addEventListener 语义（属性赋值 onopen/onmessage
    // 在 undici 下不可靠），且 ev.data 可能是字符串或 Blob，需归一化。
    const ws = new UndiciWebSocket(target.webSocketDebuggerUrl);
    const wsDataToString = (d: any): string => {
      if (typeof d === 'string') return d;
      if (d && typeof d.text === 'function') return ''; // Blob：异步，CDP 场景不会出现
      return String(d ?? '');
    };

    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP 连接超时')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', (e: any) => { clearTimeout(t); rej(new Error('CDP 连接失败: ' + (e?.message || 'unknown'))); });
    });

    let id = 0;
    const pending = new Map<number, (v: any) => void>();
    let sendFn: (method: string, params?: any) => Promise<any>;

    ws.addEventListener('message', (ev: any) => {
      const raw = wsDataToString(ev.data);
      if (!raw) return;
      let m: any;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)!(m);
        pending.delete(m.id);
      }
      // 1) 请求阶段：直接媒体请求
      if (m.method === 'Network.requestWillBeSent') {
        const u = m.params?.request?.url;
        if (u && isMediaUrl(u)) foundUrls.add(u);
      }
      // 2) 响应完成：读响应体抽媒体 URL（XHR/fetch 返回 JSON 的情况）
      if (m.method === 'Network.loadingFinished') {
        const rid = m.params?.requestId;
        if (!rid || seenRequestIds.has(rid)) return;
        seenRequestIds.add(rid);
        sendFn('Network.getResponseBody', { requestId: rid })
          .then((r) => {
            const body = r?.result?.body;
            if (typeof body === 'string' && body.length > 0 && body.length < 5_000_000) {
              extractFromText(body, new URL(startUrl), foundUrls);
            }
          })
          .catch(() => { /* 流式媒体等拿不到 body 的正常失败 */ });
      }
    });

    sendFn = (method: string, params: any = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, res);
        try {
          ws.send(JSON.stringify({ id: i, method, params }));
        } catch (e) {
          pending.delete(i);
          rej(e);
        }
        // 单条命令 10s 超时保护，避免某条 CDP 命令挂死整个嗅探
        setTimeout(() => {
          if (pending.has(i)) { pending.delete(i); rej(new Error('CDP 命令超时')); }
        }, 10_000);
      });

    try {
      await sendFn('Network.enable');
      await sendFn('Page.enable');
      await sendFn('Runtime.enable');
      await sendFn('Page.navigate', { url: startUrl });
    } catch (e) {
      // CDP 命令失败/超时：不挂死，返回已收集到的（可能为空）
      console.error('[sniff] CDP 命令失败:', (e as Error)?.message);
    }

    // 观察一段时间（等 JS 执行 + 播放器发起请求/接口响应）
    while (Date.now() < deadline && foundUrls.size === 0) {
      await new Promise((r) => setTimeout(r, 300));
    }
    // 命中后多等一小会儿收集更多候选（清晰度等）
    await new Promise((r) => setTimeout(r, 2500));

    // 拿标题
    try {
      const titleRes = (await sendFn('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      })) as any;
      title = titleRes?.result?.result?.value || '';
    } catch { /* ignore */ }

    try { ws.close(); } catch { /* ignore */ }
    return { urls: Array.from(foundUrls), title, usedBrowser: true };
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// =====================================================================
// 嗅探主接口
// =====================================================================
proxyRouter.get('/sniff', async (req, res: Response) => {
  const raw = req.query.url;
  if (typeof raw !== 'string' || !raw) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }
  if (!isHttpUrl(raw)) {
    return res.status(400).json({ error: '仅支持 http/https 链接' });
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).json({ error: '链接格式无效' });
  }

  if (parsed.username || parsed.password) {
    return res.status(400).json({ error: '不支持带凭据的链接' });
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return res.status(400).json({ error: '禁止访问本地/内网主机' });
  }
  if (await hostResolvesPrivate(host)) {
    return res.status(400).json({ error: '禁止访问内网地址' });
  }

  // 输入本身就是媒体直链：直接返回（时长照常分析）
  if (isMediaUrl(parsed.toString())) {
    const d = await probeDuration(parsed.toString());
    return res.json({
      urls: [{ url: parsed.toString(), duration: d }],
      title: '',
      usedBrowser: false,
    });
  }

  // 第一档：轻量抓取（主页面 + iframe）
  const light = await sniffLightweight(parsed.toString());

  // 第二档：轻量没抓到就上无头浏览器
  let finalUrls = light.urls;
  let title = light.title;
  let usedBrowser = false;

  if (finalUrls.length === 0) {
    const browser = await sniffWithBrowser(parsed.toString());
    if (browser.urls.length > 0) {
      finalUrls = browser.urls;
      title = browser.title || title;
      usedBrowser = browser.usedBrowser;
    }
  }

  // 时长分析（后台并行，单条失败不影响整体）
  const withDuration = await Promise.all(
    finalUrls
      // 最后一道兜底过滤：剔除 .d.ts 等静态声明文件（它们在浏览器里会被当作
      // 媒体请求捕获到，但绝不是可播放的直链）
      .filter((u) => !/\.d\.ts(\?|$)/i.test(u) && isMediaUrl(u))
      .map(async (url) => {
        const duration = await probeDuration(url);
        return { url, duration };
      })
  );

  // 排序：>15 分钟的排最前（按时长降序），其次是有时长的，最后是未知时长的
  const MIN_DURATION = 15 * 60;
  withDuration.sort((a, b) => {
    const aLong = a.duration != null && a.duration >= MIN_DURATION;
    const bLong = b.duration != null && b.duration >= MIN_DURATION;
    if (aLong !== bLong) return aLong ? -1 : 1;
    const da = a.duration ?? -1;
    const db = b.duration ?? -1;
    return db - da;
  });

  res.json({ urls: withDuration, title, usedBrowser });
});
