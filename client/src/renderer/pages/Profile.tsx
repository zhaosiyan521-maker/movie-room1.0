import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore, api } from '../store/authStore';
import { useVerifyStore, isPendingFresh } from '../store/verifyStore';
import SendVerifyLink from '../components/SendVerifyLink';
import './Profile.css';

interface MyRoom {
  id: string;
  name: string;
  status: string;
  currentMovie?: string;
  createdAt: string;
  _count?: { members: number };
}

const USERNAME_COOLDOWN_DAYS = 30;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function Profile() {
  const { user, fetchUser, logout } = useAuthStore();
  const { pending, clear } = useVerifyStore();
  const navigate = useNavigate();
  const [nickname, setNickname] = useState(user?.nickname || '');
  const [username, setUsername] = useState(user?.username || '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  /**
   * 半透明提示弹窗（居中卡片）。
   * 用于两处：用户名 30 天冷却期未满、用户名与昵称重名。
   * 复用全站既有的 .modal-mask 半透明遮罩，点遮罩或「知道了」都能关闭。
   */
  const [notice, setNotice] = useState<string | null>(null);

  // 我创建的房间（屏幕上的板块已按要求移除，这里保留取数逻辑与状态，
  // 以便日后需要时直接恢复 UI，不再取数）
  const [myRooms, setMyRooms] = useState<MyRoom[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);

  // 修改密码
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwSaving, setPwSaving] = useState(false);

  // 绑定/更换邮箱
  const [bindEmail, setBindEmail] = useState('');
  const [bindMsg, setBindMsg] = useState('');
  const [bindSaving, setBindSaving] = useState(false);
  /** 「更换邮箱」弹窗开关：输入新邮箱 + 滑块验证 + 发送验证链接都在弹窗内完成 */
  const [showEmailModal, setShowEmailModal] = useState(false);

  // 邮箱链接验证是否完成
  // 必须同时校验时效：原先只看「本地有没有这个 token」，
  // 令牌在服务端过期后 UI 仍显示绿色「已验证」并允许提交，
  // 用户要填完整张表单最后一步才被拒绝。
  const pendingFresh = isPendingFresh(pending);
  const pwEmailVerified =
    pendingFresh && pending!.purpose === 'change-password' && pending!.email === (user?.email || '');
  const bindEmailVerified =
    pendingFresh && pending!.purpose === 'bind-email' && pending!.email === bindEmail.trim();

  useEffect(() => {
    fetchUser();
    fetchMyRooms();
  }, []);

  // 仅在「服务端用户名确实变了」时同步，避免 fetchUser 返回新对象引用
  // 把用户正在输入的昵称/用户名静默清空。
  useEffect(() => {
    setUsername(prev => (user?.username !== undefined && user.username !== prev ? user.username : prev));
  }, [user]);

  const fetchMyRooms = async () => {
    try {
      const { data } = await api.get('/rooms/my/hosts');
      setMyRooms(data.rooms || []);
    } catch (error) {
      console.error('获取我创建的房间失败:', error);
    } finally {
      setRoomsLoading(false);
    }
  };

  // 用户名下次可修改时间
  const nextUsernameChangeDate = (() => {
    if (!user?.usernameChangedAt) return null;
    const d = new Date(user.usernameChangedAt);
    d.setDate(d.getDate() + USERNAME_COOLDOWN_DAYS);
    return d > new Date() ? d : null;
  })();

  const usernameLocked = !!nextUsernameChangeDate;

  /**
   * 距可修改用户名还有几天（向上取整：不足 1 天也显示 1 天）。
   * 例：还剩 2.4 天 → 3；还剩 0.5 天 → 1。
   */
  const daysUntilUsernameChange = (() => {
    if (!nextUsernameChangeDate) return 0;
    const ms = nextUsernameChangeDate.getTime() - Date.now();
    return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  })();

  const handleSave = async () => {
    setSaving(true);
    setMessage('');

    // 用户名 30 天冷却：本地已算出可修改时间，直接拦下、不发无用请求。
    // 输入框在锁定期内是 disabled 的，因此这里主要防「用户在锁定前就把新用户名
    // 填好、锁定后才点保存」这类边界，以及任何绕过 UI 的调用。
    if (username !== user?.username && usernameLocked) {
      setSaving(false);
      setNotice(`请于${daysUntilUsernameChange}天后修改`);
      return;
    }

    try {
      const payload: any = { nickname };
      if (username !== user?.username) {
        payload.username = username;
      }
      await api.patch('/users/profile', payload);
      setMessage('保存成功');
      fetchUser();
    } catch (error: any) {
      const errMsg = String(error.response?.data?.error || '保存失败');
      // 用户名/昵称重名：用与冷却提示一致的半透明弹窗，而不是行内消息
      if (errMsg.includes('昵称')) {
        setNotice('该昵称已存在');
      } else if (errMsg.includes('用户名')) {
        setNotice('该用户名已存在');
      } else {
        setMessage(errMsg);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    setPwMsg('');
    if (pwNew.length < 8) {
      setPwMsg('新密码长度至少 8 位');
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwMsg('两次输入的新密码不一致');
      return;
    }

    const payload: any = { newPassword: pwNew };
    if (user?.isAdmin && pwCurrent) {
      payload.currentPassword = pwCurrent; // 管理员可凭当前密码免邮箱验证
    } else if (pwEmailVerified) {
      payload.emailVerifyToken = pending!.token;
    } else {
      setPwMsg('请验证邮箱');
      return;
    }

    setPwSaving(true);
    try {
      await api.post('/users/change-password', payload);
      setPwMsg('密码修改成功');
      setPwCurrent('');
      setPwNew('');
      setPwConfirm('');
      clear();
    } catch (e: any) {
      const msg = e.response?.data?.error || '修改失败';
      setPwMsg(/验证|verify/i.test(String(msg)) ? '请验证邮箱' : msg);
    } finally {
      setPwSaving(false);
    }
  };

  /**
   * 打开「更换邮箱」弹窗：清空上一次的输入与提示，但如果本地已存在一条尚未使用的
   * 已验证记录（用户可能刚验证完就关掉了弹窗），则直接沿用，避免重复走滑块+邮件。
   */
  const openEmailModal = () => {
    setBindMsg('');
    setShowEmailModal(true);
  };

  /**
   * 完成更换邮箱。弹窗内已完成「滑块人机验证 + 邮件链接验证」，
   * 这里只负责凭验证令牌提交。
   */
  const handleBindEmail = async () => {
    setBindMsg('');
    if (!EMAIL_RE.test(bindEmail)) {
      setBindMsg('请输入有效的新邮箱地址');
      return;
    }
    if (!bindEmailVerified) {
      setBindMsg('请先完成邮箱验证');
      return;
    }
    setBindSaving(true);
    try {
      await api.post('/users/bind-email', { email: bindEmail, emailVerifyToken: pending!.token });
      setBindEmail('');
      clear();
      fetchUser();
      setShowEmailModal(false);
      setMessage('邮箱更换成功');
    } catch (e: any) {
      const msg = e.response?.data?.error || '更换失败';
      setBindMsg(/验证|verify/i.test(String(msg)) ? '请先完成邮箱验证' : msg);
    } finally {
      setBindSaving(false);
    }
  };

  const handleLogout = () => {
    logout();
    // 必须一并清除邮箱验证令牌：它是可用凭据，明文留在 localStorage 中，
    // 在公用/共享机器上会被下一位使用者读出并冒用该邮箱完成注册或改密。
    clear();
    navigate('/login');
  };

  const statusText = (status: string) => {
    switch (status) {
      case 'WAITING': return '等待中';
      case 'PLAYING': return '播放中';
      case 'ENDED': return '已结束';
      default: return status;
    }
  };

  return (
    <div className="profile-page fade-in">
      <h1>👤 个人中心</h1>

      <div className="profile-content-single">
        <div className="card profile-card">
          <h2>基本信息</h2>

          <div className="avatar-section">
            <div className="avatar-placeholder">
              {(user?.nickname || user?.username)?.charAt(0).toUpperCase()}
            </div>
          </div>

          <div className="form-group">
            <label className="label">用户名</label>
            <input
              type="text"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              // 30 天冷却期内不进入编辑状态（按需求：只保留倒计时小字提示）
              disabled={usernameLocked}
              placeholder="3-20 位字母、数字或下划线"
            />
            {/* 锁定期内只显示倒计时小字；解锁后不显示任何规则说明（原两种长文案已按要求清除） */}
            {usernameLocked && (
              <span className="hint">请于{daysUntilUsernameChange}天后修改</span>
            )}
          </div>

          <div className="form-group">
            <label className="label">邮箱</label>
            <div className="email-row">
              <input
                type="email"
                className="input"
                value={user?.email || ''}
                disabled
              />
              {/* 「邮箱」与「绑定/更换邮箱」合并为一处：按钮直接开弹窗填新邮箱 */}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={openEmailModal}
              >
                更换邮箱
              </button>
            </div>
            {bindEmailVerified && pending?.email && (
              <span className="hint success-hint">✅ 新邮箱已验证：{pending.email}，点击「保存修改」完成更换</span>
            )}
          </div>

          <div className="form-group">
            <label className="label">昵称</label>
            <input
              type="text"
              className="input"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="请输入昵称"
            />
            <span className="hint">昵称不能与其他用户重复，且不超过 10 个字</span>
          </div>

          {message && (
            <div className={`message ${message.includes('成功') ? 'success' : 'error'}`}>
              {message}
            </div>
          )}

          <button
            onClick={handleSave}
            className="btn btn-primary"
            disabled={saving}
          >
            {saving ? '保存中...' : '保存修改'}
          </button>
        </div>

        {/* 修改密码 */}
        <div className="card profile-card">
          <h2>🔒 修改密码</h2>
          <div className="form-group">
            <label className="label">新密码 *</label>
            <input
              type="password"
              className="input"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
              placeholder="至少 8 位"
            />
          </div>
          <div className="form-group">
            <label className="label">确认新密码 *</label>
            <input
              type="password"
              className="input"
              value={pwConfirm}
              onChange={(e) => setPwConfirm(e.target.value)}
              placeholder="请再次输入新密码"
            />
          </div>

          {user?.isAdmin ? (
            <div className="form-group">
              <label className="label">当前密码（管理员可凭此免邮箱验证）</label>
              <input
                type="password"
                className="input"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                placeholder="留空则改用邮箱验证链接"
              />
            </div>
          ) : null}

          {pwEmailVerified ? (
            <div className="svl-message success" style={{ marginBottom: 16 }}>
              ✅ 邮箱已验证：{pending!.email}
            </div>
          ) : (
            <div className="form-group">
              <label className="label">
                {user?.isAdmin ? '或：通过邮箱验证链接修改（滑块 + 点击邮件链接）' : '邮箱验证（滑块 + 点击邮件链接）'}
              </label>
              <SendVerifyLink email={user?.email || ''} purpose="change-password" buttonLabel="发送验证链接" />
            </div>
          )}

          {pwMsg && (
            <div className={`message ${pwMsg.includes('成功') ? 'success' : 'error'}`}>
              {pwMsg}
            </div>
          )}

          <button
            onClick={handleChangePassword}
            className="btn btn-primary"
            disabled={pwSaving}
          >
            {pwSaving ? '修改中...' : '修改密码'}
          </button>
        </div>
      </div>

      {/* 退出登录：按要求只保留按钮本身（去掉板块外框与说明文字） */}
      <div className="profile-logout">
        <button
          onClick={handleLogout}
          className="btn btn-danger"
        >
          退出登录
        </button>
      </div>

      {/* 用户名冷却 / 重名提示：半透明遮罩 + 居中卡片，与打赏弹窗同款观感 */}
      {notice && (
        <div className="modal-mask" onClick={() => setNotice(null)}>
          <div
            className="modal-card card notice-card"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="notice-text">{notice}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setNotice(null)}
            >
              知道了
            </button>
          </div>
        </div>
      )}

      {/* 更换邮箱弹窗：新邮箱输入 + 滑块人机验证 + 发送验证链接，全部在弹窗内完成 */}
      {showEmailModal && (
        <div className="modal-mask" onClick={() => !bindSaving && setShowEmailModal(false)}>
          <div
            className="modal-card card"
            role="dialog"
            aria-modal="true"
            aria-label="更换邮箱"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>📧 更换邮箱</h3>
            <div className="form-group" style={{ marginTop: 12 }}>
              <label className="label">新邮箱地址</label>
              <input
                type="email"
                className="input"
                value={bindEmail}
                onChange={(e) => setBindEmail(e.target.value)}
                placeholder="请输入要更换的邮箱"
                autoFocus
              />
            </div>

            {bindEmailVerified ? (
              <div className="svl-message success" style={{ marginBottom: 16 }}>
                ✅ 邮箱已验证：{pending!.email}
              </div>
            ) : (
              <div className="form-group">
                <label className="label">邮箱验证（滑块 + 点击邮件链接）</label>
                <SendVerifyLink email={bindEmail} purpose="bind-email" buttonLabel="发送验证链接" />
              </div>
            )}

            {bindMsg && (
              <div className={`message ${bindMsg.includes('成功') ? 'success' : 'error'}`}>
                {bindMsg}
              </div>
            )}

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowEmailModal(false)}
                disabled={bindSaving}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleBindEmail}
                disabled={bindSaving}
              >
                {bindSaving ? '更换中...' : '更换邮箱'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
