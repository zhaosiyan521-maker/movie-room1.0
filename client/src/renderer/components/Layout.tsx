import { useState, useEffect } from 'react';
import { Outlet, Link } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
// 走 import 让 Vite 处理资源路径，避免打包后资源路径失效 404
import tipQrWechat from '/tip-qr-wechat.png';
import tipQrAlipay from '/tip-qr-alipay.png';
import './Layout.css';

// 打赏弹窗推送间隔：7 天
const TIP_POPUP_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const TIP_POPUP_KEY = 'mr_support_popup_at';

export default function Layout() {
  const { user } = useAuthStore();
  const [showTip, setShowTip] = useState(false);
  // 每 7 天自动弹出一次的支持弹窗
  const [showSupportPopup, setShowSupportPopup] = useState(false);

  // 每 7 天弹出一次支持弹窗（记录时间戳在展示时写入，避免反复打扰）
  useEffect(() => {
    try {
      const last = Number(localStorage.getItem(TIP_POPUP_KEY) || 0);
      if (!last || Date.now() - last > TIP_POPUP_INTERVAL) {
        setShowSupportPopup(true);
        localStorage.setItem(TIP_POPUP_KEY, String(Date.now()));
      }
    } catch { /* localStorage 不可用时静默跳过 */ }
  }, []);

  // 弹窗：Escape 关闭 + 背景锁滚动 + 组件卸载时复原
  useEffect(() => {
    if (!showTip && !showSupportPopup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowTip(false);
        setShowSupportPopup(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [showTip, showSupportPopup]);

  // 头像：优先用户自定义头像，否则用渐变底 + 首字符的默认头像
  const displayName = user?.nickname || user?.username || '?';

  return (
    <div className="layout">
      <header className="header">
        <div className="brand-area">
          <div className="brand-row">
            <Link to="/" className="logo">
              🎬 Movie Room
            </Link>
            <button className="tip-author-btn" onClick={() => setShowTip(true)}>
              ❤️ 打赏作者
            </button>
          </div>
        </div>

        <nav className="nav">
          <Link to="/" className="nav-link">房间列表</Link>
          <Link to="/create" className="nav-link btn btn-primary">创建房间</Link>
          <Link to="/my-rooms" className="nav-link">我的房间</Link>
          {user?.isAdmin && (
            <Link to="/admin" className="nav-link admin-link">🛡️ 管理后台</Link>
          )}
        </nav>

        <div className="user-menu">
          {/* 头像即个人中心入口：点击头像图片进入个人中心 */}
          <Link to="/profile" className="avatar-link" title="个人中心">
            {user?.avatar ? (
              <img src={user.avatar} alt="个人中心" className="header-avatar" />
            ) : (
              <span className="header-avatar header-avatar-fallback">
                {displayName.charAt(0).toUpperCase()}
              </span>
            )}
          </Link>
        </div>
      </header>

      <main className="main-content">
        <Outlet />
      </main>

      {/* 每 7 天一次的支持弹窗 */}
      {showSupportPopup && (
        <div className="modal-mask" onClick={() => setShowSupportPopup(false)}>
          <div
            className="tip-modal support-popup card"
            role="dialog"
            aria-modal="true"
            aria-label="支持作者"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="support-popup-emoji">☕</div>
            <h3>喜欢这个平台吗？</h3>
            <p className="tip-modal-text">
              本网站所有费用均为作者自费，如果喜欢本网站可以请作者喝杯咖啡 ☕
            </p>
            <div className="support-popup-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setShowSupportPopup(false);
                  setShowTip(true);
                }}
              >
                ☕ 打赏作者
              </button>
              <button className="btn btn-secondary" onClick={() => setShowSupportPopup(false)}>
                先用用看
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 打赏二维码弹窗 */}
      {showTip && (
        <div className="modal-mask" onClick={() => setShowTip(false)}>
          <div
            className="tip-modal card"
            role="dialog"
            aria-modal="true"
            aria-label="打赏作者"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>❤️ 打赏作者</h3>
            <p className="tip-modal-text">感谢你的支持，这是作者持续维护的动力！</p>
            <div className="tip-qr-row">
              <div className="tip-qr-item">
                <img src={tipQrWechat} alt="微信打赏二维码" />
                <span>微信打赏</span>
              </div>
              <div className="tip-qr-item">
                <img src={tipQrAlipay} alt="支付宝打赏二维码" />
                <span>支付宝打赏</span>
              </div>
            </div>
            <button className="btn btn-secondary" onClick={() => setShowTip(false)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
