import { speedToScrollDuration } from '../utils/danmakuSpeed';
import type { BroadcastInfo } from '../store/broadcastSocket';
import './BroadcastBar.css';

/**
 * 【需求4A】管理员广播：一条循环滚动的文字。
 *
 * 由服务端经 `broadcast-update`（管理员发布/停播时实时推送、客户端连接建立时下发一次）
 * 下发，不需要轮询。永久循环滚动，直到管理员手动停播。
 *
 * 显示范围：房间页（RoomView）与大厅（房间列表）等所有登录后页面，见 Layout。
 * 未登录页面不显示（本项目未登录时无法进入任何页面）。
 */

export default function BroadcastBar({ broadcast }: { broadcast: BroadcastInfo | null }) {
  if (!broadcast) return null;

  return (
    <div className="broadcast-bar" role="marquee" aria-label="管理员广播">
      <span className="broadcast-label">📢</span>
      <div className="broadcast-track">
        <div
          // key 用广播 id：发布新广播时强制重挂载，动画从头开始（否则沿用旧动画进度）
          key={broadcast.id}
          className="broadcast-text"
          style={{
            color: broadcast.color,
            animationDuration: `${speedToScrollDuration(broadcast.speed)}s`
          }}
        >
          {broadcast.content}
        </div>
      </div>
    </div>
  );
}
