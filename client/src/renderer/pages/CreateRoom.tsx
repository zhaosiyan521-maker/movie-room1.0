import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../store/authStore';
import './CreateRoom.css';

const MAX_IMAGES = 5;
// 单张图片体积上限（读取前拦截，避免 base64 膨胀拖垮进程）
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// 解码后像素总量上限（约 8000×5000）。缩放发生在解码之后，
// 一张高压缩比的巨图（如 30000×30000 PNG）解码即需数 GB 内存，
// 不校验会导致 Electron 渲染进程 OOM 崩溃。
const MAX_PIXELS = 40_000_000;

/**
 * 客户端压缩图片：最大边长 1000px，JPEG 0.8。
 *
 * 关键点：img.onload 内必须整体 try/catch。
 * Promise 构造函数的 executor 在 new Promise() 返回时就已执行完毕，
 * 此后回调里抛出的异常不会被外层捕获，会变成未捕获的全局错误，
 * 而外层 Promise 永远 pending —— 导致 await 永久挂起、finally 不执行，
 * 文件 input 的 value 也无法重置（再次选同一文件连 change 都不触发）。
 */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      return reject(new Error('请选择图片文件'));
    }
    if (file.size > MAX_FILE_BYTES) {
      return reject(new Error('图片不能超过 10MB'));
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片读取失败'));
      img.onload = () => {
        try {
          if (!img.naturalWidth || !img.naturalHeight) {
            return reject(new Error('图片尺寸无效'));
          }
          if (img.naturalWidth * img.naturalHeight > MAX_PIXELS) {
            return reject(new Error('图片分辨率过大，请压缩后再上传'));
          }

          const maxSide = 1000;
          let width = img.naturalWidth;
          let height = img.naturalHeight;
          if (width > maxSide || height > maxSide) {
            const ratio = Math.min(maxSide / width, maxSide / height);
            width = Math.max(1, Math.round(width * ratio));
            height = Math.max(1, Math.round(height * ratio));
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('图片处理失败'));
          ctx.drawImage(img, 0, 0, width, height);

          const url = canvas.toDataURL('image/jpeg', 0.8);
          if (!url.startsWith('data:image/jpeg')) {
            return reject(new Error('图片编码失败'));
          }
          resolve(url);
        } catch {
          // 无论如何都要 settle，避免 Promise 永久挂起
          reject(new Error('图片处理失败'));
        }
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export default function CreateRoom() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '',
    description: '',
    password: '',
    maxViewers: 30
  });
  const [images, setImages] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const value = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    // 函数式更新：不依赖渲染时的 form 快照，避免同批次多次变更互相覆盖
    setForm(prev => ({ ...prev, [e.target.name]: value }));
  };

  const handleAddImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      setError(`最多只能添加 ${MAX_IMAGES} 张图片`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // allSettled 而非 all：一张失败不至于让已成功的图片全部白做
    const results = await Promise.allSettled(
      files.slice(0, remaining).map(compressImage)
    );
    const ok = results
      .filter(r => r.status === 'fulfilled')
      .map(r => (r as PromiseFulfilledResult<string>).value);
    const failed = results.length - ok.length;

    if (ok.length) {
      setImages(prev => [...prev, ...ok]);
    }
    if (failed > 0) {
      setError(`${failed} 张图片处理失败（可能过大或格式不支持），其余已添加`);
    } else {
      setError('');
    }
    // 重置 input，保证连续选择同一文件也能再次触发 change
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { data } = await api.post('/rooms', {
        name: form.name,
        description: form.description || undefined,
        password: form.password || undefined,
        maxViewers: form.maxViewers,
        images
      });

      navigate(`/room/${data.room.id}`);
    } catch (error: any) {
      setError(error.response?.data?.error || '创建房间失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="create-room-page fade-in">
      <div className="create-room-container">
        <h1>🎬 创建观影房间</h1>
        <p className="subtitle">设置你的房间，邀请好友一起看电影</p>

        <form onSubmit={handleSubmit} className="create-form">
          {error && <div className="error-message">{error}</div>}

          <div className="form-section">
            <h3>基本信息</h3>

            <div className="form-group">
              <label className="label">房间名称 *</label>
              <input
                type="text"
                name="name"
                className="input"
                value={form.name}
                onChange={handleChange}
                placeholder="例如：周末电影之夜"
                required
                maxLength={50}
              />
              <span className="hint">房间名称在全平台不能重复</span>
            </div>

            <div className="form-group">
              <label className="label">房间描述</label>
              <textarea
                name="description"
                className="input textarea"
                value={form.description}
                onChange={handleChange}
                placeholder="简单描述一下要播放的电影或活动..."
                rows={3}
                maxLength={200}
              />
            </div>

            <div className="form-group">
              <label className="label">房间图片（最多 {MAX_IMAGES} 张，观众在房间外可见）</label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={handleAddImages}
              />
              <div className="image-picker">
                {images.map((img, idx) => (
                  // 用图片 URL 作为 key：删除中间项时 React 不会复用错位的 DOM 节点
                  <div key={img} className="image-preview">
                    <img src={img} alt={`房间图片 ${idx + 1}`} />
                    <button
                      type="button"
                      className="image-remove"
                      onClick={() => removeImage(idx)}
                      title="删除图片"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {images.length < MAX_IMAGES && (
                  <button
                    type="button"
                    className="image-add-btn"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <span className="image-add-icon">🖼️</span>
                    <span>添加图片</span>
                    <span className="image-add-count">{images.length}/{MAX_IMAGES}</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="form-section">
            <h3>访问控制</h3>

            <div className="form-group">
              <label className="label">入场密码（可选）</label>
              <input
                type="password"
                name="password"
                className="input"
                value={form.password}
                onChange={handleChange}
                placeholder="留空表示不需要密码"
              />
              <span className="hint">设置密码后，观众需要输入密码才能加入</span>
            </div>

            <div className="form-group">
              <label className="label">最大观众数</label>
              <select
                name="maxViewers"
                className="input"
                value={form.maxViewers}
                onChange={handleChange}
              >
                {[5, 10, 15, 20, 25, 30].map(n => (
                  <option key={n} value={n}>{n} 人</option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => navigate('/')}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || !form.name.trim()}
            >
              {loading ? '创建中...' : '创建房间'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
