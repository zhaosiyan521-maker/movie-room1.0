import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useVerifyStore } from '../store/verifyStore';
import SendVerifyLink from '../components/SendVerifyLink';
import './Login.css';

export default function Register() {
  const [searchParams] = useSearchParams();
  // 从验证成功跳转过来的 URL 里读取邮箱，自动回填，避免用户手动重填导致验证状态对不上
  const emailFromUrl = searchParams.get('email') || '';
  const [form, setForm] = useState({
    username: '',
    email: emailFromUrl,
    password: '',
    confirmPassword: '',
    nickname: ''
  });
  const [error, setError] = useState('');
  const { register, isLoading } = useAuthStore();
  const { pending, clear } = useVerifyStore();
  const navigate = useNavigate();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  // 邮箱是否已完成「点击邮件验证链接」这一步
  const emailVerified =
    !!pending &&
    pending.purpose === 'register' &&
    !!form.email &&
    pending.email === form.email;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (form.password !== form.confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    if (form.password.length < 8) {
      setError('密码长度至少 8 位');
      return;
    }

    // 按钮保持可交互：点击时先本地判断是否有验证令牌，再交给服务端最终求证。
    if (!emailVerified) {
      setError('请验证邮箱');
      return;
    }

    try {
      await register({
        username: form.username,
        email: form.email,
        password: form.password,
        nickname: form.nickname || undefined,
        emailVerifyToken: pending!.token
      });
      // 一次性令牌用完即清，避免重复使用
      clear();
      navigate('/');
    } catch (err: any) {
      const msg = err.response?.data?.error || err || '注册失败';
      // 服务端求证未通过时，统一给用户「请验证邮箱」的明确提示
      if (/验证|verify/i.test(String(msg))) {
        setError('请验证邮箱');
      } else {
        setError(msg);
      }
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1>🎬 Movie Room</h1>
          <p>创建账号，开始共享观影</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {error && <div className="error-message">{error}</div>}

          <div className="form-group">
            <label className="label">用户名 *</label>
            <input
              type="text"
              name="username"
              className="input"
              value={form.username}
              onChange={handleChange}
              placeholder="请输入用户名"
              required
            />
          </div>

          <div className="form-group">
            <label className="label">邮箱 *</label>
            <input
              type="email"
              name="email"
              className="input"
              value={form.email}
              onChange={handleChange}
              placeholder="请输入邮箱"
              required
            />
          </div>

          {emailVerified ? (
            <div
              className="svl-message success"
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              ✅ 邮箱已验证：{pending!.email}
              <button
                type="button"
                className="link-text"
                style={{ background: 'none', border: 'none', color: 'var(--primary-color)', cursor: 'pointer', padding: 0 }}
                onClick={clear}
              >
                换一个邮箱
              </button>
            </div>
          ) : (
            <div className="form-group">
              <label className="label">📧 邮箱验证：点击按钮 → 完成滑块 → 查收邮件</label>
              <SendVerifyLink email={form.email} purpose="register" buttonLabel="向邮箱发送验证链接" />
            </div>
          )}

          <div className="form-group">
            <label className="label">昵称（可选）</label>
            <input
              type="text"
              name="nickname"
              className="input"
              value={form.nickname}
              onChange={handleChange}
              placeholder="请输入昵称"
            />
          </div>

          <div className="form-group">
            <label className="label">密码 *</label>
            <input
              type="password"
              name="password"
              className="input"
              value={form.password}
              onChange={handleChange}
              placeholder="请输入密码（至少 8 位）"
              required
            />
          </div>

          <div className="form-group">
            <label className="label">确认密码 *</label>
            <input
              type="password"
              name="confirmPassword"
              className="input"
              value={form.confirmPassword}
              onChange={handleChange}
              placeholder="请再次输入密码"
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={isLoading}
          >
            {isLoading ? '注册中...' : '注册'}
          </button>
        </form>

        <div className="login-footer">
          已有账号？<Link to="/login">立即登录</Link>
        </div>
      </div>
    </div>
  );
}
