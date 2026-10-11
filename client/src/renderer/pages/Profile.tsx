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
  const { user, fetchUser } = useAuthStore();
  const { pending, clear } = useVerifyStore();
  const navigate = useNavigate();
  const [nickname, setNickname] = useState(user?.nickname || '');
  const [username, setUsername] = useState(user?.username || '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // 我创建的房间
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

  const handleSave = async () => {
    setSaving(true);
    setMessage('');

    try {
      const payload: any = { nickname };
      if (username !== user?.username) {
        payload.username = username;
      }
      await api.patch('/users/profile', payload);
      setMessage('保存成功');
      fetchUser();
    } catch (error: any) {
      setMessage(error.response?.data?.error || '保存失败');
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

  const handleBindEmail = async () => {
    setBindMsg('');
    if (!EMAIL_RE.test(bindEmail)) {
      setBindMsg('请输入有效的新邮箱地址');
      return;
    }
    if (!bindEmailVerified) {
      setBindMsg('请验证邮箱');
      return;
    }
    setBindSaving(true);
    try {
      await api.post('/users/bind-email', { email: bindEmail, emailVerifyToken: pending!.token });
      setBindMsg('邮箱绑定成功');
      setBindEmail('');
      clear();
      fetchUser();
    } catch (e: any) {
      const msg = e.response?.data?.error || '绑定失败';
      setBindMsg(/验证|verify/i.test(String(msg)) ? '请验证邮箱' : msg);
    } finally {
      setBindSaving(false);
    }
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
              disabled={usernameLocked}
              placeholder="3-20 位字母、数字或下划线"
            />
            <span className="hint">
              {usernameLocked
                ? `用户名每 ${USERNAME_COOLDOWN_DAYS} 天只能修改一次，下次可修改时间：${nextUsernameChangeDate!.toLocaleDateString('zh-CN')}`
                : `用户名每 ${USERNAME_COOLDOWN_DAYS} 天只能修改一次，且不能与其他用户重复`}
            </span>
          </div>

          <div className="form-group">
            <label className="label">邮箱</label>
            <input
              type="email"
              className="input"
              value={user?.email || ''}
              disabled
            />
            <span className="hint">邮箱不可直接修改，请使用下方「绑定/更换邮箱」</span>
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

        {/* 绑定 / 更换邮箱 */}
        <div className="card profile-card">
          <h2>📧 绑定 / 更换邮箱</h2>
          <div className="form-group">
            <label className="label">新邮箱地址 *</label>
            <input
              type="email"
              className="input"
              value={bindEmail}
              onChange={(e) => setBindEmail(e.target.value)}
              placeholder="请输入要绑定的新邮箱"
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

          <button
            onClick={handleBindEmail}
            className="btn btn-primary"
            disabled={bindSaving}
          >
            {bindSaving ? '绑定中...' : '绑定邮箱'}
          </button>
        </div>
      </div>

      {/* 我创建的房间 */}
      <div className="card my-rooms-card">
        <h2>🎬 我创建的房间</h2>
        {roomsLoading ? (
          <p className="empty-text">加载中...</p>
        ) : myRooms.length === 0 ? (
          <p className="empty-text">
            你还没有创建过房间，
            <span className="link-text" onClick={() => navigate('/create')}>去创建一个</span>
          </p>
        ) : (
          <div className="my-rooms-list">
            {myRooms.map(room => {
              // 已结束的房间不可进入
              if (room.status === 'ENDED') {
                return (
                  <div key={room.id} className="my-room-item is-disabled" aria-disabled="true">
                    <div className="my-room-main">
                      <span className="my-room-name">{room.name}</span>
                      <span className={`room-status-badge status-${room.status.toLowerCase()}`}>
                        {statusText(room.status)}
                      </span>
                    </div>
                    <div className="my-room-meta">
                      <span>👥 {room._count?.members || 0} 人</span>
                      {room.currentMovie && <span>📽️ {room.currentMovie}</span>}
                      <span>{new Date(room.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                );
              }
              // 可进入的房间用 Link，键盘与读屏用户同样可达
              return (
                <Link
                  key={room.id}
                  to={`/room/${room.id}`}
                  className="my-room-item"
                >
                  <div className="my-room-main">
                    <span className="my-room-name">{room.name}</span>
                    <span className={`room-status-badge status-${room.status.toLowerCase()}`}>
                      {statusText(room.status)}
                    </span>
                  </div>
                  <div className="my-room-meta">
                    <span>👥 {room._count?.members || 0} 人</span>
                    {room.currentMovie && <span>📽️ {room.currentMovie}</span>}
                    <span>{new Date(room.createdAt).toLocaleDateString()}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
