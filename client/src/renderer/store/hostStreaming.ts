/**
 * 房主推流会话管理器（模块级单例）。
 *
 * 背景：房主在放映途中点击「我的房间 / 房间列表 / 个人中心」等导航时，
 * RoomView 组件会卸载，其内部的 <video> 元素、WebRTC PeerConnection、
 * 以及 socket 连接都会随之销毁——导致本地文件（WebRTC 推流）模式下的
 * 观众画面中断、房间被误判为「房主离开」。
 *
 * 本模块把「房主的推流核心资源」从 React 组件生命周期中解耦出来，
 * 挂到模块级单例上，使房主切换页面后：
 *   - 本地视频元素继续存活（挂载在 document.body，脱离组件）；
 *   - WebRTC PeerConnection 与推流轨道继续存活；
 *   - socket 连接继续存活（服务端不会把房主判为离开）。
 *
 * 只有房主主动「解散房间 / 退出房间」或真正断网时，才销毁对应会话。
 *
 * 多房间：房主可同时存在于最多 5 个房间，每个房间拥有独立的会话，
 * 互不干扰（video / peers / socket 均按 roomId 隔离）。
 */

import { io, Socket } from 'socket.io-client';
import { getAbsoluteApiBase } from './apiBase';

export interface HostSession {
  roomId: string;
  socket: Socket;
  /** 房主的本地视频元素（挂载在 document.body，脱离组件生命周期） */
  video: HTMLVideoElement;
  /** 当前片源：网络直链 or 本地文件 */
  usingRemoteUrl: boolean;
  remoteUrl: string;
  isHls: boolean;
  /** 本地文件模式下，captureStream 产生的推流 */
  captureStream: MediaStream | null;
  /** 网络直链模式下的 HLS 实例（持久化，房主切页后继续拉流播放，回来复用避免孤儿冲突） */
  hls: any | null;
  /** 是否正在放映 */
  playing: boolean;
  /** socket 事件监听器是否已绑定（跨组件复用，避免重复绑定导致消息叠加） */
  listenersBound: boolean;
  /** 房主是否已加入该信令房间 */
  joinedRoom: boolean;
  /**
   * 与房间内各观众的 WebRTC 连接（socketId -> RTCPeerConnection）。
   * 必须是会话级持有：组件级 useRef 不跨组件实例存活，房主切页后旧 PC 会失控泄漏（僵尸连接）。
   */
  peers: Map<string, RTCPeerConnection>;
}

const sessions = new Map<string, HostSession>();

/** 取得（或创建）某房间的房主推流会话 */
export function getOrCreateHostSession(roomId: string): HostSession {
  let s = sessions.get(roomId);
  if (!s) {
    const token = localStorage.getItem('token');
    const socket = io(`${getAbsoluteApiBase()}`, {
      auth: { token },
      transports: ['websocket']
    });
    const video = document.createElement('video');
    video.playsInline = true;
    video.controls = true;
    video.className = 'video-player';
    video.muted = false;
    // 初始为「隐藏」状态（脱离组件时挂 body）；挂载进房间页面时由 RoomView 恢复可见
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    video.style.top = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    s = {
      roomId,
      socket,
      video,
      usingRemoteUrl: false,
      remoteUrl: '',
      isHls: false,
      captureStream: null,
      hls: null,
      playing: false,
      listenersBound: false,
      joinedRoom: false,
      peers: new Map()
    };
    sessions.set(roomId, s);
  }
  return s;
}

export function getHostSession(roomId: string): HostSession | undefined {
  return sessions.get(roomId);
}

/**
 * 彻底销毁某房间的房主会话（仅在房主真正离开/解散时调用）。
 * 停止推流、关闭 peers、断开 socket、移除视频元素。
 */
export function destroyHostSession(roomId: string): void {
  const s = sessions.get(roomId);
  if (!s) return;
  sessions.delete(roomId);

  try {
    if (s.captureStream) {
      s.captureStream.getTracks().forEach(t => t.stop());
      s.captureStream = null;
    }
  } catch { /* ignore */ }
  try {
    if (s.hls) {
      s.hls.destroy();
      s.hls = null;
    }
  } catch { /* ignore */ }
  try {
    s.video.pause();
    s.video.src = '';
    s.video.srcObject = null;
    if (s.video.parentNode) s.video.parentNode.removeChild(s.video);
  } catch { /* ignore */ }
  try {
    // 关闭全部 WebRTC 连接（否则切页残留的僵尸 PC 会继续占连接与带宽直到 ICE 超时）
    s.peers.forEach(pc => { try { pc.close(); } catch { /* ignore */ } });
    s.peers.clear();
  } catch { /* ignore */ }
  try {
    s.socket.disconnect();
  } catch { /* ignore */ }
}

/** 房间总数（用于调试/确认多房间隔离） */
export function hostSessionCount(): number {
  return sessions.size;
}
