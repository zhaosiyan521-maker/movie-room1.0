import { io, Socket } from 'socket.io-client';
import { getAbsoluteApiBase } from './apiBase';

/**
 * 【需求4A】管理员广播的全局订阅通道（与 React 无关的纯模块，便于 authStore 直接调用）。
 *
 * - 全应用共用**一条** socket（模块级单例）：大厅、房间页、个人中心等只需一条长连接即可
 *   实时收到广播，避免每页各开一条。
 * - **零轮询**：管理员发布 / 停播时由服务端 `io.emit('broadcast-update')` 实时推送；
 *   服务端在**连接建立时**也会下发一次当前广播，因此刷新页面无需额外请求。
 * - **HTTP 兜底**：WebSocket 被阻断时，仍会通过 `GET /api/broadcast/active`
 *   拉取一次当前广播（只拉一次，不轮询）。
 *
 * 注意：本文件不可 import authStore（authStore 会 import 本文件触发登出清理），否则形成循环依赖。
 */

export interface BroadcastInfo {
  id: string;
  content: string;
  color: string;
  speed: number; // 1~5 档，与视频弹幕同口径
}

type Listener = (b: BroadcastInfo | null) => void;

let socket: Socket | null = null;
let socketToken: string | null = null;
let current: BroadcastInfo | null = null;
let initFetchedForToken: string | null = null;

const listeners = new Set<Listener>();

function emit(b: BroadcastInfo | null) {
  current = b;
  listeners.forEach((l) => {
    try {
      l(b);
    } catch {
      /* 单个订阅者异常不影响其它订阅者 */
    }
  });
}

function closeSocket() {
  if (!socket) return;
  try {
    socket.removeAllListeners();
    socket.disconnect();
  } catch {
    /* ignore */
  }
  socket = null;
  socketToken = null;
}

/** 当前缓存的广播值（用于组件首次渲染，避免一闪而空） */
export function getCurrentBroadcast(): BroadcastInfo | null {
  return current;
}

/** 订阅广播变化，返回取消订阅函数 */
export function subscribeBroadcast(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 确保已用指定令牌建立（或重建）订阅连接 */
export function ensureBroadcastSocket(token: string) {
  if (socket && socketToken !== token) closeSocket();

  if (!socket) {
    socket = io(getAbsoluteApiBase(), {
      auth: { token },
      transports: ['websocket']
    });
    socketToken = token;

    // 管理员发布 / 停播时服务端推送（null 表示当前没有广播）
    socket.on('broadcast-update', (data: BroadcastInfo | null) => emit(data || null));
    // 连接建立 / 断线重连后服务端会重新下发当前广播；先给出缓存值，避免闪断时广播条闪没
    socket.on('connect', () => {
      listeners.forEach((l) => l(current));
    });
    // 广播不是关键路径，连接失败静默（HTTP 兜底会补上）
    socket.on('connect_error', () => {
      /* ignore */
    });
  }
}

/**
 * HTTP 兜底：每个令牌只拉取一次当前广播。
 * WebSocket 正常时服务端已推送过同样的值，故仅当本地仍无数据时才采纳。
 */
export function fetchInitialBroadcast(token: string) {
  if (initFetchedForToken === token) return;
  initFetchedForToken = token;

  fetch(`${getAbsoluteApiBase()}/api/broadcast/active`, {
    headers: { Authorization: `Bearer ${token}` }
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && d.broadcast && current === null) emit(d.broadcast);
    })
    .catch(() => {
      /* ignore */
    });
}

/** 登出 / 令牌失效时调用：断开订阅连接并清空缓存 */
export function resetBroadcastSocket() {
  closeSocket();
  initFetchedForToken = null;
  emit(null);
}
