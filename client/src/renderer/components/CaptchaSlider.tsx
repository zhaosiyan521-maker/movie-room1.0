import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../store/authStore';
import './CaptchaSlider.css';

interface Props {
  onVerified: (captchaToken: string) => void;
}

type Status = 'loading' | 'idle' | 'dragging' | 'verifying' | 'ok' | 'fail';

interface Challenge {
  id: string;
  bg: string;
  piece: string;
}

/**
 * 三角形拼图滑块人机验证。
 *
 * 服务端生成带三角形缺口的底图与对应的拼图碎片，碎片为半透明背景上的三角形截图。
 * 真值 gap 保留在服务端，客户端拖动左侧碎片与缺口对齐后上报位置。
 */
export default function CaptchaSlider({ onVerified }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const challengeId = useRef('');
  const dragging = useRef(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [pos, setPos] = useState(0.12);      // 当前拼图碎片中心位置（比例）
  const [status, setStatus] = useState<Status>('loading');

  const refresh = useCallback(async () => {
    setStatus('loading');
    try {
      const { data } = await api.post('/auth/captcha/challenge');
      challengeId.current = data.id;
      setChallenge({ id: data.id, bg: data.bg || '', piece: data.piece || '' });
      setPos(0.12);
      setStatus('idle');
    } catch {
      setStatus('fail');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const fractionFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (status === 'ok' || status === 'verifying' || status === 'loading') return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragging.current = true;
    setStatus('dragging');
    setPos(fractionFromClientX(e.clientX));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current || status !== 'dragging') return;
    setPos(fractionFromClientX(e.clientX));
  };

  const onPointerUp = async () => {
    if (!dragging.current || status !== 'dragging') return;
    dragging.current = false;
    setStatus('verifying');
    try {
      const { data } = await api.post('/auth/captcha/verify', {
        id: challengeId.current,
        pos,
      });
      setStatus('ok');
      onVerified(data.captchaToken);
    } catch {
      setStatus('fail');
      await refresh();
    }
  };

  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <div className="captcha-slider">
      <div className="captcha-title">请拖动左侧滑块将图片还原</div>
      <div
        className={`captcha-track ${status === 'ok' ? 'is-ok' : ''} ${status === 'fail' ? 'is-fail' : ''}`}
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { dragging.current = false; setStatus('idle'); }}
      >
        {challenge?.bg && (
          <img className="captcha-bg" src={challenge.bg} alt="滑动验证背景图" draggable={false} />
        )}
        {challenge?.piece && (
          <img
            className="captcha-piece"
            src={challenge.piece}
            alt="拼图碎片"
            draggable={false}
            style={{ left: pct(pos) }}
          />
        )}
      </div>

      <div className="captcha-hint">
        {status === 'loading' && '正在加载验证...'}
        {status === 'idle' && '拖动左侧拼图，使其与缺口重合'}
        {status === 'dragging' && '松开鼠标完成验证'}
        {status === 'verifying' && '验证中...'}
        {status === 'ok' && '✅ 人机验证通过'}
        {status === 'fail' && '验证未通过，正在刷新，请重试'}
        {status === 'fail' && (
          <button type="button" className="captcha-retry" onClick={refresh}>重新加载</button>
        )}
      </div>
    </div>
  );
}
