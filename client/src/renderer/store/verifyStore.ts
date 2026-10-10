import { create } from 'zustand';

export type VerifyPurpose = 'register' | 'change-password' | 'bind-email';

export interface PendingVerify {
  token: string;
  email: string;
  purpose: VerifyPurpose;
  at: number;   // 暂存时间戳，用于本地时效判断
}

interface VerifyState {
  // 邮箱验证链接点击后暂存的令牌（持久化到 localStorage，跨标签页可用）
  pending: PendingVerify | null;
  set: (v: Omit<PendingVerify, 'at'> & { at?: number }) => void;
  clear: () => void;
}

const KEY = 'movie_pending_verify';
const PURPOSES: VerifyPurpose[] = ['register', 'change-password', 'bind-email'];
// 与服务端 emailVerifyTtlSec（30 分钟）保持一致，并留出余量
export const PENDING_TTL = 30 * 60 * 1000;

/**
 * 读取暂存的验证令牌。
 *
 * 必须做运行时结构校验：原先 `JSON.parse(s) as PendingVerify` 只是编译期断言，
 * 不会校验实际结构，localStorage 被改坏时会带着 undefined 字段一路传给后端。
 */
function read(): PendingVerify | null {
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return null;
    const v = JSON.parse(s);
    const valid =
      v &&
      typeof v.token === 'string' && v.token.length > 0 &&
      typeof v.email === 'string' && v.email.length > 0 &&
      typeof v.purpose === 'string' && PURPOSES.includes(v.purpose) &&
      typeof v.at === 'number';
    if (!valid) {
      localStorage.removeItem(KEY);
      return null;
    }
    // 本地过期即丢弃，避免用户填完整个表单最后一步才被服务端拒绝
    if (Date.now() - v.at > PENDING_TTL) {
      localStorage.removeItem(KEY);
      return null;
    }
    return v as PendingVerify;
  } catch {
    return null;
  }
}

/** 判断暂存令牌是否仍在有效期内（供页面展示「已验证」状态前调用） */
export function isPendingFresh(p: PendingVerify | null): boolean {
  if (!p) return false;
  return Date.now() - p.at <= PENDING_TTL;
}

export const useVerifyStore = create<VerifyState>((set) => ({
  pending: read(),
  set: (v) => {
    const value: PendingVerify = { ...v, at: v.at ?? Date.now() };
    localStorage.setItem(KEY, JSON.stringify(value));
    set({ pending: value });
  },
  clear: () => {
    localStorage.removeItem(KEY);
    set({ pending: null });
  }
}));
