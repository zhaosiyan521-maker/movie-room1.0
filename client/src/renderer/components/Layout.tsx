import { useState, useEffect, useRef, useCallback } from 'react';
import { Outlet, Link } from 'react-router-dom';
import { useAuthStore, api } from '../store/authStore';
// 走 import 让 Vite 处理资源路径，避免打包后资源路径失效 404
import tipQrWechat from '/tip-qr-wechat.png';
import tipQrAlipay from '/tip-qr-alipay.png';
import './Layout.css';

// 打赏弹窗推送间隔：7 天
const TIP_POPUP_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const TIP_POPUP_KEY = 'mr_support_popup_at';

/** 【需求4B】管理员公告 */
interface Announcement {
  id: string;
  title: string | null;
  content: string;
  createdAt: string;
}

export default function Layout() {
  const { user } = useAuthStore();
  const [showTip, setShowTip] = useState(false);
  // 每 7 天自动弹出一次的支持弹窗
  const [showSupportPopup, setShowSupportPopup] = useState(false);

  // 【需求4B】公告弹窗：拉取「当前登录用户尚未读过」的公告，依次展示。
  // 每关闭一条即调用标记已读接口，因此同一条公告对同一用户只会出现一次。
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [annIndex, setAnnIndex] = useState(0);
  // 本次访问是否已经出现过「7 天打赏弹窗」。一旦出现，本次访问就不再弹公告
  // （公告顺延到下次访问），而不是等用户关掉打赏弹窗后再补弹一次。
  const supportShownRef = useRef(false);

  // 每 7 天弹出一次支持弹窗（记录时间戳在展示时写入，避免反复打扰）
  useEffect(() => {
    try {
      const last = Number(localStorage.getItem(TIP_POPUP_KEY) || 0);
      if (!last || Date.now() - last > TIP_POPUP_INTERVAL) {
        setShowSupportPopup(true);
        supportShownRef.current = true;
        localStorage.setItem(TIP_POPUP_KEY, String(Date.now()));
      }
    } catch { /* localStorage 不可用时静默跳过 */ }
  }, []);

  // 拉取未读公告：未登录用户不请求、也不显示（既定决策）。
  // 拉取失败静默忽略 —— 公告不是关键路径，不该打扰用户。
  useEffect(() => {
    if (!user?.id) {
      setAnnouncements([]);
      setAnnIndex(0);
      return;
    }
    let cancelled = false;
    api.get('/announcements/active')
      .then(({ data }) => {
        if (cancelled) return;
        setAnnouncements(Array.isArray(data?.announcements) ? data.announcements : []);
        setAnnIndex(0);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [user?.id]);

  const currentAnnouncement = announcements[annIndex] || null;
  // 与「每 7 天的打赏弹窗」互斥：打赏弹窗优先。
  // 本次访问只要出现过打赏弹窗（supportShownRef），公告就整体顺延到下次访问再弹；
  // 由于从未调用标记已读接口，服务端仍认为该用户未读，下次访问会再次下发 —— 即「下次再弹」。
  const showAnnouncement = !!currentAnnouncement && !supportShownRef.current && !showTip;

  // 关闭当前公告：先标记已读（失败也不阻断，下次仍会弹，属可接受的降级），再展示下一条
  const closeAnnouncement = useCallback(() => {
    const cur = announcements[annIndex];
    if (cur) {
      api.post(`/announcements/${cur.id}/read`).catch(() => { /* ignore */ });
    }
    setAnnIndex(i => i + 1);
  }, [announcements, annIndex]);

  // 弹窗：Escape 关闭 + 背景锁滚动 + 组件卸载时复原
  useEffect(() => {
    if (!showTip && !showSupportPopup && !showAnnouncement) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 打赏类弹窗优先关闭；两者都不在时关闭公告
      if (showTip || showSupportPopup) {
        setShowTip(false);
        setShowSupportPopup(false);
        return;
      }
      closeAnnouncement();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [showTip, showSupportPopup, showAnnouncement, closeAnnouncement]);

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

      {/* 【需求4B】公告弹窗：首屏展示，每名登录用户对同一条公告只显示一次 */}
      {showAnnouncement && currentAnnouncement && (
        <div className="modal-mask" onClick={closeAnnouncement}>
          <div
            className="tip-modal announcement-modal card"
            role="dialog"
            aria-modal="true"
            aria-label={currentAnnouncement.title || '系统公告'}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="announcement-close"
              onClick={closeAnnouncement}
              aria-label="关闭公告"
              title="关闭"
            >
              ×
            </button>
            <h3>📣 {currentAnnouncement.title || '系统公告'}</h3>
            <div className="announcement-body">{currentAnnouncement.content}</div>
            <button className="btn btn-primary" onClick={closeAnnouncement}>
              我知道了
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
