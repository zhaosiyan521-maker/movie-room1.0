import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import zlib from 'zlib';
import { config } from '../config';

/**
 * 滑块验证码：服务端生成「带缺口的底图」与对应的「拼图碎片」。
 * 真值 gap 只保存在服务端内存中，绝不随响应下发。
 * 客户端拖动左侧拼图碎片，使其与底图缺口对齐后上报位置，服务端校验误差在容差内即签发一次性票据。
 */
interface Challenge {
  gap: number;      // 正确位置（0~1 比例）——仅服务端持有
  bg: string;       // 带缺口的底图
  piece: string;    // 可拖动的拼图碎片
  exp: number;      // 过期时间戳
}

const challenges = new Map<string, Challenge>();

// 清理过期挑战，避免内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of challenges) {
    if (now > c.exp) challenges.delete(id);
  }
}, 60 * 1000).unref();

// 防止无界增长
const MAX_CHALLENGES = 50_000;

// 底图尺寸（与客户端渲染尺寸保持一致比例，客户端按 CSS 缩放）
const IMG_W = 300;
const IMG_H = 150;

// 拼图：等边三角形
const TRI_SIZE = 44;
const TRI_H = TRI_SIZE * Math.sqrt(3) / 2;

function crc32(buf: Buffer): number {
  const table = crcTable();
  let c: number = -1;
  for (let n = 0; n < buf.length; n++) {
    c = table[(c ^ buf[n]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

let CRC_TABLE: Int32Array | null = null;
function crcTable(): Int32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 将 RGB(A) 像素缓冲编码为 PNG data URL */
function encodePng(pixels: Buffer, w: number, h: number, channels: 3 | 4 = 3): string {
  const colorType = channels === 4 ? 6 : 2; // 6=RGBA, 2=RGB
  const bpp = channels;
  const raw = Buffer.alloc(h * (w * bpp + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * bpp + 1)] = 0;
    pixels.copy(raw, y * (w * bpp + 1) + 1, y * w * bpp, (y + 1) * w * bpp);
  }
  const idat = zlib.deflateSync(raw);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;     // compression
  ihdr[11] = 0;     // filter
  ihdr[12] = 0;     // interlace

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** 判断点 (x,y) 是否在以 (cx,cy) 为中心、边长为 size 的等边三角形内 */
function inTriangle(x: number, y: number, cx: number, cy: number, size: number): boolean {
  const h = size * Math.sqrt(3) / 2;
  // 顶点：朝上
  const ax = cx;
  const ay = cy - (2 * h) / 3;
  const bx = cx - size / 2;
  const by = cy + h / 3;
  const cx2 = cx + size / 2;

  // 使用向量点积的重心坐标法，避免退化三角形导致 denom 为 0
  const v0x = cx2 - ax;
  const v0y = cy - ay; // cy2 === by
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = x - ax;
  const v2y = y - ay;

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot20 = v2x * v0x + v2y * v0y;
  const dot21 = v2x * v1x + v2y * v1y;

  const denom = dot00 * dot11 - dot01 * dot01;
  if (denom === 0) return false;
  const u = (dot11 * dot20 - dot01 * dot21) / denom;
  const v = (dot00 * dot21 - dot01 * dot20) / denom;
  return u >= 0 && v >= 0 && u + v <= 1;
}

interface Background {
  rgb: Buffer;
}

/** 生成基础背景（柔和渐变 + 色块 + 噪点） */
function renderBackground(): Background {
  const rgb = Buffer.alloc(IMG_W * IMG_H * 3);
  const baseHue = Math.random() * 360;
  const [br, bg, bb] = hslToRgb(baseHue, 0.45, 0.55);
  const blobs: Array<{ x: number; y: number; r: number; c: [number, number, number] }> = [];
  for (let i = 0; i < 12; i++) {
    const hue = Math.random() * 360;
    blobs.push({
      x: Math.random() * IMG_W,
      y: Math.random() * IMG_H,
      r: 12 + Math.random() * 34,
      c: hslToRgb(hue, 0.5, 0.6),
    });
  }

  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      let r = br, g = bg, b = bb;
      const t = y / IMG_H;
      r = Math.min(255, r * (0.82 + 0.35 * (1 - t)));
      g = Math.min(255, g * (0.82 + 0.35 * (1 - t)));
      b = Math.min(255, b * (0.82 + 0.35 * (1 - t)));

      for (const bl of blobs) {
        const d2 = (x - bl.x) ** 2 + (y - bl.y) ** 2;
        if (d2 <= bl.r * bl.r) {
          const a = 1 - d2 / (bl.r * bl.r);
          r = r * (1 - a * 0.5) + bl.c[0] * a * 0.5;
          g = g * (1 - a * 0.5) + bl.c[1] * a * 0.5;
          b = b * (1 - a * 0.5) + bl.c[2] * a * 0.5;
        }
      }

      const n = (Math.random() - 0.5) * 16;
      r += n; g += n; b += n;

      const i = (y * IMG_W + x) * 3;
      rgb[i] = Math.max(0, Math.min(255, Math.round(r)));
      rgb[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgb[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  return { rgb };
}

/** 生成带缺口的底图 + 拼图碎片 */
function buildPuzzleImage(gap: number): { bg: string; piece: string } {
  const gapX = Math.round(gap * IMG_W);
  const { rgb: base } = renderBackground();

  // ---- 底图：在 gap 处挖一个三角形缺口 ----
  const bg = Buffer.from(base);
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      if (inTriangle(x, y, gapX, IMG_H / 2, TRI_SIZE)) {
        const edge = !inTriangle(x - 1, y, gapX, IMG_H / 2, TRI_SIZE) ||
                     !inTriangle(x + 1, y, gapX, IMG_H / 2, TRI_SIZE) ||
                     !inTriangle(x, y - 1, gapX, IMG_H / 2, TRI_SIZE) ||
                     !inTriangle(x, y + 1, gapX, IMG_H / 2, TRI_SIZE);
        const i = (y * IMG_W + x) * 3;
        if (edge) {
          bg[i] = 255; bg[i + 1] = 255; bg[i + 2] = 255;
        } else {
          bg[i] = Math.max(0, Math.min(255, Math.round(bg[i] * 0.32)));
          bg[i + 1] = Math.max(0, Math.min(255, Math.round(bg[i + 1] * 0.32)));
          bg[i + 2] = Math.max(0, Math.min(255, Math.round(bg[i + 2] * 0.32)));
        }
      }
    }
  }

  // ---- 拼图碎片：把缺口对应的背景区域切出来，加上绿色描边 ----
  const piecePad = 10;
  const pieceW = TRI_SIZE + piecePad * 2;          // 碎片画布宽
  const pieceH = Math.ceil(TRI_H) + piecePad * 2;  // 碎片画布高
  const piece = Buffer.alloc(pieceW * pieceH * 4);
  const pieceCx = pieceW / 2;
  const pieceCy = pieceH / 2;

  for (let y = 0; y < pieceH; y++) {
    for (let x = 0; x < pieceW; x++) {
      const i = (y * pieceW + x) * 4;
      const inP = inTriangle(x, y, pieceCx, pieceCy, TRI_SIZE);
      if (!inP) {
        piece[i] = 0; piece[i + 1] = 0; piece[i + 2] = 0; piece[i + 3] = 0;
        continue;
      }

      // 把碎片上的像素映射回底图原始坐标（碎片中心对齐缺口中心）
      const srcX = gapX + (x - pieceCx);
      const srcY = IMG_H / 2 + (y - pieceCy);
      if (srcX >= 0 && srcX < IMG_W && srcY >= 0 && srcY < IMG_H) {
        const si = (Math.round(srcY) * IMG_W + Math.round(srcX)) * 3;
        piece[i] = base[si];
        piece[i + 1] = base[si + 1];
        piece[i + 2] = base[si + 2];
      } else {
        piece[i] = 200; piece[i + 1] = 200; piece[i + 2] = 200;
      }

      // 绿色描边
      const edge = !inTriangle(x - 1, y, pieceCx, pieceCy, TRI_SIZE) ||
                   !inTriangle(x + 1, y, pieceCx, pieceCy, TRI_SIZE) ||
                   !inTriangle(x, y - 1, pieceCx, pieceCy, TRI_SIZE) ||
                   !inTriangle(x, y + 1, pieceCx, pieceCy, TRI_SIZE);
      if (edge) {
        piece[i] = 0; piece[i + 1] = 230; piece[i + 2] = 150;
      }
      piece[i + 3] = 255;
    }
  }

  return {
    bg: encodePng(bg, IMG_W, IMG_H, 3),
    piece: encodePng(piece, pieceW, pieceH, 4),
  };
}

/** 生成一个滑块挑战。返回值只有挑战 id、底图与碎片，正确位置 gap 不返回。 */
export function createChallenge(): { id: string; bg: string; piece: string } {
  if (challenges.size > MAX_CHALLENGES) challenges.clear();
  const id = uuidv4();
  const gap = Number((0.2 + Math.random() * 0.6).toFixed(3)); // 0.2~0.8
  const { bg, piece } = buildPuzzleImage(gap);
  challenges.set(id, { gap, bg, piece, exp: Date.now() + config.captchaValidSec * 1000 });
  return { id, bg, piece };
}

/** 校验滑块位置。成功则消耗挑战并签发一次性 captcha 票据。 */
export function verifyCaptcha(id: string, pos: number): string | null {
  if (typeof id !== 'string' || id.length > 64) return null;
  if (typeof pos !== 'number' || !Number.isFinite(pos)) return null;

  const c = challenges.get(id);
  if (!c) return null;
  challenges.delete(id);
  if (Date.now() > c.exp) return null;
  if (pos < 0 || pos > 1) return null;
  if (Math.abs(pos - c.gap) > 0.03) return null; // 容差 3%

  return jwt.sign({ type: 'captcha' }, config.jwtSecret, {
    expiresIn: `${config.captchaTtlSec}s`,
  });
}

/** 校验 captcha 票据是否有效 */
export function isValidCaptchaToken(token: string): boolean {
  if (typeof token !== 'string' || !token) return false;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as any;
    return payload.type === 'captcha';
  } catch {
    return false;
  }
}
