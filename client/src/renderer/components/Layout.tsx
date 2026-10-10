import { useState, useEffect } from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useVerifyStore } from '../store/verifyStore';
// 走 import 让 Vite 处理资源路径：vite.config 里 base 为 './'（file:// 协议需要），
// 硬编码 "/tip-qr-wechat.png" 在打包后会被解析成 file:///tip-qr-wechat.png（根目录）而 404。
import tipQrWechat from '/tip-qr-wechat.png';
import tipQrAlipay from '/tip-qr-alipay.png';
import './Layout.css';

export default function Layout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [showTip, setShowTip] = useState(false);

  const handleLogout = () => {
    logout();
    // 必须一并清除邮箱验证令牌：它是可用凭据，明文留在 localStorage 中，
    // 在公用/共享机器上会被下一位使用者读出并冒用该邮箱完成注册或改密。
    useVerifyStore.getState().clear();
    navigate('/login');
  };

  // 弹窗：Escape 关闭 + 背景锁滚动 + 组件卸载时复原
  useEffect(() => {
    if (!showTip) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowTip(false);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [showTip]);

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
          <p className="tip-slogan">维护不易，如果你喜欢这个平台，可以请作者喝杯咖啡 ☕</p>
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
          <span className="user-name">{user?.nickname || user?.username}</span>
          <Link to="/profile" className="nav-link">个人中心</Link>
          <button onClick={handleLogout} className="btn btn-secondary btn-sm">
            退出
          </button>
        </div>
      </header>

      <main className="main-content">
        <Outlet />
      </main>

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
            <p className="tip-modal-text">维护不易，如果你喜欢这个平台，可以请作者喝杯咖啡 ☕</p>
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
