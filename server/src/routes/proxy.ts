import express, { Router, Response } from 'express';
import dns from 'dns';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Agent } from 'undici';

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

/**
 * 从页面 HTML/JS 文本中提取媒体直链（.m3u8 / .mp4 / .webm / .flv）。
 *
 * 要点：
 *   - 先反解常见 JS 转义（\/ \u002F \x2F），让藏在脚本字符串里的 URL 能被正则命中；
 *   - 同时匹配绝对 URL 与「引号包裹的相对/裸路径」，相对路径用页面 base 解析为绝对地址；
 *   - 去重 + 仅保留 http(s)。
 */
function extractMediaUrls(html: string, base: URL): string[] {
  const found = new Set<string>();

  const unescaped = html
    .replace(/\\\//g, '/')
    .replace(/\\u002F/gi, '/')
    .replace(/\\x2F/gi, '/');

  // 绝对 URL（含查询串），去掉末尾可能的引号/逗号/反斜杠等噪声
  const absRe = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|webm|flv)(?:\?[^\s"'<>\\]*)?/gi;
  for (const m of unescaped.match(absRe) || []) {
    const cleaned = m.replace(/[\\'",;)\]]+$/, '');
    found.add(cleaned);
  }

  // 引号包裹的路径形式（相对或裸路径），用 base 解析
  const relRe = /(?:"|')([^"']*?\.(?:m3u8|mp4|webm|flv)(?:\?[^"']*)?)(?:"|')/gi;
  let mm: RegExpExecArray | null;
  while ((mm = relRe.exec(unescaped))) {
    const candidate = mm[1];
    try {
      const abs = new URL(candidate, base).toString();
      if (/^https?:/i.test(abs)) found.add(abs);
    } catch { /* 忽略无法解析的路径 */ }
  }

  return Array.from(found).filter((u) => {
    try {
      const p = new URL(u);
      return p.protocol === 'http:' || p.protocol === 'https:';
    } catch {
      return false;
    }
  });
}

/**
 * 网络视频直链嗅探。
 *
 * 房主输入一个视频页面地址，服务端抓取该页 HTML，提取其中的 .m3u8/.mp4/.webm/.flv
 * 直链返回给前端展示。只覆盖「直链明文写在页面源码里」的资源站/解析站；
 * 依赖 JS 动态拼接 + 加密的大平台不在能力范围内。
 *
 * 复用 video-proxy 同一套 SSRF 防护与 dispatcher（绕过系统代理劫持）。
 */
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

  // 输入本身就是媒体直链：直接原样返回
  if (/\.(m3u8|mp4|webm|flv)(\?|$)/i.test(parsed.pathname)) {
    return res.json({ urls: [parsed.toString()], title: '' });
  }

  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: parsed.origin + '/',
  };

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(parsed.toString(), {
      method: 'GET',
      headers,
      redirect: 'follow',
      dispatcher,
    } as any);
  } catch (err) {
    console.error('[sniff] 抓取失败:', (err as Error)?.message);
    return res.status(502).json({ error: '无法获取目标页面' });
  }

  if (!upstream.ok) {
    return res.status(upstream.status || 502).json({ error: `上游返回 ${upstream.status}` });
  }

  const html = await upstream.text();
  const urls = extractMediaUrls(html, parsed);

  let title = '';
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (titleMatch) title = titleMatch[1].trim();

  res.json({ urls, title });
});
