import { Router, Request, Response } from 'express';
import { getActiveBroadcast } from '../services/signaling';

/**
 * 【需求4A】管理员广播（面向所有访客，无需登录）。
 *
 * 广播本身是「发给所有人看的通知」，不含任何敏感信息，因此读取接口不需要鉴权 ——
 * 这样大厅（房间列表）、未登录页面也能显示广播条。
 *
 * 实时性不依赖本接口：正常情况下由 socket.io 的 `broadcast-update` 事件推送
 * （见 services/signaling.ts 的 pushBroadcastUpdate / 连接建立时下发）。
 * 本接口仅作为「WebSocket 不可用」时的兜底，客户端每个会话只请求一次，不做轮询。
 */
export const broadcastRouter = Router();

/** 获取当前生效的广播（没有则返回 null） */
broadcastRouter.get('/active', async (_req: Request, res: Response) => {
  try {
    const broadcast = await getActiveBroadcast();
    res.json({ broadcast });
  } catch (error) {
    console.error('Get active broadcast error:', error);
    res.status(500).json({ error: '获取广播失败' });
  }
});
