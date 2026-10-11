import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../store/authStore';
import { useVerifyStore } from '../store/verifyStore';
import './EmailVerify.css';

type Status = 'loading' | 'ok' | 'error';

const PURPOSE_TEXT: Record<string, string> = {
  register: '注册账号',
  'change-password': '修改密码',
  'bind-email': '绑定/更换邮箱',
};

const PURPOSE_TARGET: Record<string, string> = {
  register: '/register',
  'change-password': '/profile',
  'bind-email': '/profile',
};

export default function EmailVerify() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { set } = useVerifyStore();
  const [status, setStatus] = useState<Status>('loading');
  const [info, setInfo] = useState<{ email: string; purpose: string } | null>(null);
  const [error, setError] = useState('');

  const rawT = params.get('t') || '';
  // 清洗 token：邮件客户端会把长链接折行，用户复制时可能带入换行/空格/尖括号等
  // 附加字符，导致 jwt.verify 失败而误报「无效或已过期」。这里做保守清洗。
  const t = rawT.trim().replace(/[\r\n\s]+/g, '').replace(/[<>]/g, '');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!t) {
        if (!cancelled) {
          setStatus('error');
          setError('链接缺少验证参数，请重新获取验证链接');
        }
        return;
      }
      try {
        const { data } = await api.get('/auth/verify-email', { params: { t } });
        if (cancelled) return;
        // 暂存令牌到本地（跨标签页可用），目标页面读取后即可完成对应操作
        set({ token: t, email: data.email, purpose: data.purpose });
        setInfo({ email: data.email, purpose: data.purpose });
        setStatus('ok');
      } catch (e: any) {
        if (cancelled) return;
        setStatus('error');
        setError(e.response?.data?.error || '验证链接无效或已过期，请重新获取');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, set]);

  return (
    <div className="email-verify-page">
      <div className="email-verify-card">
        {status === 'loading' && (
          <>
            <div className="ev-spinner" />
            <h2>正在验证...</h2>
            <p>请稍候，正在校验您的邮箱验证链接</p>
          </>
        )}

        {status === 'ok' && info && (
          <>
            <div className="ev-icon ev-ok">✅</div>
            <h2>邮箱验证成功</h2>
            <p>
              已确认邮箱 <strong>{info.email}</strong>，本次操作为「{PURPOSE_TEXT[info.purpose] || info.purpose}」。
            </p>
            <p className="ev-tip">请返回对应页面继续操作。点击下方按钮即可前往。</p>
            <button
              className="btn btn-primary btn-block"
              onClick={() => {
                // 跳转时把邮箱带过去，让目标页面（如注册页）自动回填，避免用户手动重填导致状态对不上
                const target = PURPOSE_TARGET[info.purpose] || '/';
                navigate(`${target}?email=${encodeURIComponent(info.email)}`);
              }}
            >
              前往{PURPOSE_TEXT[info.purpose] || '操作'}
            </button>
            <div className="email-verify-footer">
              <Link to="/">返回首页</Link>
            </div>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="ev-icon ev-fail">⚠️</div>
            <h2>验证失败</h2>
            <p className="ev-error">{error}</p>
            <div className="email-verify-footer">
              <Link to="/register">前往注册</Link>
              <Link to="/login">前往登录</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
