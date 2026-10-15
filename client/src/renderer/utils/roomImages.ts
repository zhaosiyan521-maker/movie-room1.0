/**
 * 房间图片处理（客户端压缩）。
 *
 * 从 pages/CreateRoom.tsx 抽出：新需求要求「编辑房间信息」的弹窗与「创建房间」的表单一致，
 * 两处都要上传图片并压缩。若各自复制一份，将来改压缩参数或修 bug 必然只改一处。
 *
 * 关键点：img.onload 内必须整体 try/catch。
 * Promise 构造函数的 executor 在 new Promise() 返回时就已执行完毕，
 * 此后回调里抛出的异常不会被外层捕获，会变成未捕获的全局错误，
 * 而外层 Promise 永远 pending —— 导致 await 永久挂起、finally 不执行，
 * 文件 input 的 value 也无法重置（再次选同一文件连 change 都不触发）。
 */

export const MAX_ROOM_IMAGES = 5;
/** 单张图片体积上限（读取前拦截，避免 base64 膨胀拖垮进程） */
export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
/**
 * 解码后像素总量上限（约 8000×5000）。缩放发生在解码之后，
 * 一张高压缩比的巨图（如 30000×30000 PNG）解码即需数 GB 内存，
 * 不校验会导致渲染进程 OOM 崩溃。
 */
export const MAX_IMAGE_PIXELS = 40_000_000;

/** 客户端压缩图片：最大边长 1000px，JPEG 0.8 */
export function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      return reject(new Error('请选择图片文件'));
    }
    if (file.size > MAX_IMAGE_FILE_BYTES) {
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
          if (img.naturalWidth * img.naturalHeight > MAX_IMAGE_PIXELS) {
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

/**
 * 批量选择图片并压缩。返回成功项与失败数量。
 * allSettled 而非 all：一张失败不至于让已成功的图片全部白做。
 */
export async function compressImageFiles(
  files: File[],
  remainingSlots: number
): Promise<{ ok: string[]; failed: number }> {
  if (files.length === 0 || remainingSlots <= 0) return { ok: [], failed: 0 };
  const results = await Promise.allSettled(files.slice(0, remainingSlots).map(compressImage));
  const ok = results
    .filter(r => r.status === 'fulfilled')
    .map(r => (r as PromiseFulfilledResult<string>).value);
  return { ok, failed: results.length - ok.length };
}
