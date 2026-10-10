import { useEffect, useState } from 'react';
import { api } from '../store/authStore';
import CaptchaSlider from './CaptchaSlider';
import './SendVerifyLink.css';

interface Props {
  email: string;
  purpose: 'register' | 'change-password' | 'bind-email';
  buttonLabel?: string;
  onSent?: () => void;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * 滑块人机验证 + 发送邮箱验证链接。
 *
 * 流程：先点击「发送验证链接」按钮，再显示滑块；滑块通过后人机验证票据生效，
 * 组件自动请求 /auth/send-verify-link 发送邮件。发送成功后显示状态，允许重新发送。
 */
export default function SendVerifyLink({ email, purpose, buttonLabel = '发送验证链接', onSent }: Props) {
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaKey, setCaptchaKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');
  // 未配置 SMTP 时，从服务端拿回的验证链接（本地联调用）
  const [devLink, setDevLink] = useState('');
  // 记录已发送到哪个邮箱，避免用户改完邮箱后状态错乱
  const [sentTo, setSentTo] = useState<string | null>(null);

  const sent = Boolean(sentTo) && sentTo === email;

  // 邮箱/用途变化时重置全部状态
  useEffect(() => {
    setSentTo(null);
    setCaptchaToken('');
    setMsg('');
    setDevLink('');
    setShowCaptcha(false);
  }, [email, purpose]);

  // 滑块通过后自动发邮件
  useEffect(() => {
    if (captchaToken && showCaptcha && !sent && !sending) {
      send();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captchaToken, showCaptcha, sent, sending]);

  const start = () => {
    if (!email || !EMAIL_RE.test(email.trim())) {
      setMsg('请先填写有效邮箱');
      return;
    }
    setMsg('');
    setShowCaptcha(true);
  };

  const send = async () => {
    if (!email || !EMAIL_RE.test(email.trim())) {
      setMsg('请先填写有效邮箱');
      return;
    }
    if (!captchaToken) {
      setMsg('请先完成滑块验证');
      return;
    }
    setSending(true);
    setMsg('');
    try {
      const resp: any = await api.post('/auth/send-verify-link', {
        email: email.trim(),
        purpose,
        captchaToken,
      });
      setSentTo(email.trim());
      setShowCaptcha(false);
      if (resp?.data?.devLink) {
        setDevLink(resp.data.devLink);
        setMsg('验证链接已生成（当前未配置邮件服务，请复制下方链接完成验证）');
      } else {
        setDevLink('');
        setMsg('验证链接已发送，请前往邮箱点击完成验证');
      }
      onSent?.();
    } catch (e: any) {
      setMsg(e.response?.data?.error || '发送失败，请稍后重试');
      // 发邮件失败后清空票据并刷新滑块，让用户重新拖动
      setCaptchaToken('');
      setCaptchaKey(k => k + 1);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="send-verify-link">
      {!sent ? (
        <>
          {!showCaptcha ? (
            <button
              type="button"
              className="btn btn-secondary btn-block"
              disabled={sending}
              onClick={start}
            >
              {sending ? '发送中...' : buttonLabel}
            </button>
          ) : (
            <div className="svl-captcha-panel">
              <CaptchaSlider key={captchaKey} onVerified={setCaptchaToken} />
              {msg && !sent && <div className="svl-message error">{msg}</div>}
              <button
                type="button"
                className="svl-cancel"
                onClick={() => {
                  setShowCaptcha(false);
                  setCaptchaToken('');
                  setMsg('');
                }}
              >
                取消验证
              </button>
            </div>
          )}
          {msg && !sent && !showCaptcha && (
            <div className="svl-message error">{msg}</div>
          )}
        </>
      ) : (
        <div className="svl-message success">
          {devLink ? (
            <>
              ✅ 验证链接已生成（邮件服务未配置，未真实发信）
              <div className="svl-devlink">
                <code>{devLink}</code>
                <button
                  type="button"
                  className="svl-resend"
                  onClick={() => navigator.clipboard?.writeText(devLink)}
                >复制</button>
              </div>
              <span className="svl-hint">该链接也已输出到服务端控制台</span>
            </>
          ) : (
            <>✅ 验证链接已发送至 {sentTo}，请前往邮箱点击完成验证</>
          )}
          <button
            type="button"
            className="svl-resend"
            onClick={() => {
              setSentTo(null);
              setCaptchaToken('');
              setDevLink('');
              setMsg('');
              setShowCaptcha(false);
            }}
          >
            重新发送
          </button>
        </div>
      )}
    </div>
  );
}
