/**
 * 统一的 API / 后端基地址解析。
 *
 * 背景：项目中多处硬编码了后端地址（authStore 的 '/api' 相对路径、RoomView 的
 * 'http://localhost:3001'），且视频代理用相对路径 '/api/video-proxy'，这些依赖
 * Vite 开发服务器的 /api 代理转发。一旦运行在 Electron 打包环境（file:// 协议）
 * 或前端端口不是 5173，相对路径就会解析到错误的地方，导致：
 *   - 登录/接口 404
 *   - 网络视频直链代理 `/api/video-proxy` 直接加载失败（"视频加载失败"）
 *
 * 这里统一解析出一个「绝对」后端基地址，所有 HTTP 请求与视频代理 URL 都基于它，
 * 从而在开发模式（Vite 代理）与生产模式（Electron file://）下都能正确指向后端。
 */

function detectApiBase(): string {
  // 1) 显式环境变量（Vite 通过 import.meta.env 暴露 VITE_ 前缀变量）
  const env = (import.meta as any)?.env;
  const explicit = env?.VITE_API_BASE;
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim().replace(/\/+$/, '');
  }

  // 2) Electron 渲染进程：通过 preload 暴露的主进程获取后端地址（优先，避免 file:// 下相对路径失效）
  const electronApi = (window as any)?.electronAPI;
  if (electronApi && typeof electronApi.getApiBase === 'function') {
    try {
      const base = electronApi.getApiBase();
      if (typeof base === 'string' && base.trim()) {
        return base.trim().replace(/\/+$/, '');
      }
    } catch {
      /* ignore */
    }
  }

  // 3) 开发模式：前端运行在 localhost:5173（Vite dev server）。
  //    此时相对路径 '/api' 会被 Vite 代理转发到后端，等价于 http://localhost:3001。
  //    但为了在「非 5173 端口」或「生产构建后直接静态托管」场景下依然可用，
  //    这里返回同源相对路径，让 /api 走当前 origin 的代理。
  //    注意：视频代理不能用相对路径（见下），这里仅作为 HTTP 接口的兜底。
  return '';
}

/**
 * 返回后端 HTTP 接口的基地址。
 * - 开发模式（Vite dev server）：返回 ''（相对路径，走 Vite /api 代理）
 * - 生产/Electron：返回绝对地址（如 http://localhost:3001）
 * 结尾不含斜杠。
 */
export function getApiBase(): string {
  return detectApiBase();
}

/**
 * 返回「绝对」的后端基地址（用于视频代理等必须直接指向后端的场景）。
 * 视频代理 URL 若用相对路径，在 Electron(file://) 或非 5173 端口下会解析失败。
 *
 * 解析顺序：
 *   1. VITE_API_BASE 环境变量
 *   2. Electron preload 暴露的后端地址
 *   3. 开发模式默认 http://localhost:3001（与后端默认端口一致）
 */
export function getAbsoluteApiBase(): string {
  const base = detectApiBase();
  if (base) return base;

  // 开发模式兜底：前端在 5173，后端默认 3001
  const loc = typeof window !== 'undefined' ? window.location : null;
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) {
    // 若前端与后端同域部署（通过反代），优先使用同源
    if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
      // 本地开发：假设后端在 3001（与 server 默认端口一致）
      return `${loc.protocol}//${loc.hostname}:3001`;
    }
    // 其他情况（如局域网 IP 直连）：同源
    return loc.origin;
  }

  // 最终兜底（file:// 等）：默认后端地址
  return 'http://localhost:3001';
}

/**
 * 把「远程视频直链」改写为「绝对」的同源代理地址，用于绕过跨域与防盗链。
 * - 仅改写 http(s) 绝对链接；file:/blob:/data: 及相对路径原样返回。
 * - 已改写过的不会二次改写。
 * - 返回绝对地址，避免 Electron(file://) / 非 5173 端口下相对路径失效。
 */
export function toProxiedUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  if (url.includes('/api/video-proxy')) return url;
  const base = getAbsoluteApiBase();
  return `${base}/api/video-proxy?url=${encodeURIComponent(url)}`;
}
