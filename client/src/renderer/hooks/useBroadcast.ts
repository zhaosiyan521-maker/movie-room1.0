import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import {
  ensureBroadcastSocket,
  fetchInitialBroadcast,
  getCurrentBroadcast,
  resetBroadcastSocket,
  subscribeBroadcast,
  type BroadcastInfo
} from '../store/broadcastSocket';

/**
 * 【需求4A】订阅管理员广播的 React Hook（大厅 + 房间页共用同一条连接）。
 * 返回当前生效的广播；null 表示当前没有广播（广播条应隐藏）。
 */
export function useBroadcast(): BroadcastInfo | null {
  const token = useAuthStore((s) => s.token);
  const [broadcast, setBroadcast] = useState<BroadcastInfo | null>(getCurrentBroadcast);

  useEffect(() => {
    if (!token) {
      resetBroadcastSocket();
      setBroadcast(null);
      return;
    }

    ensureBroadcastSocket(token);
    const unsubscribe = subscribeBroadcast(setBroadcast);
    // 立即同步当前缓存值（连接尚未建立时也能显示已知的广播）
    setBroadcast(getCurrentBroadcast());
    // HTTP 兜底（每个令牌一次，非轮询）
    fetchInitialBroadcast(token);

    return unsubscribe;
  }, [token]);

  return broadcast;
}
