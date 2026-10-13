import { create } from 'zustand';
import axios from 'axios';
import { resetBroadcastSocket } from './broadcastSocket';

const API_BASE = '/api';

interface User {
  id: string;
  username: string;
  email: string;
  nickname: string;
  avatar?: string;
  isAdmin?: boolean;
  usernameChangedAt?: string | null;
}

interface AuthState {
  token: string | null;
  user: User | null;
  isLoading: boolean;
  
  login: (username: string, password: string) => Promise<void>;
  register: (data: { username: string; email: string; password: string; nickname?: string; emailVerifyToken: string }) => Promise<void>;
  logout: () => void;
  fetchUser: () => Promise<void>;
}

// 创建 axios 实例
export const api = axios.create({
  baseURL: API_BASE,
});

// 请求拦截器：自动添加 token
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器：处理 401
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const url = String(error.config?.url || '');

    // 仅在「凭证型」接口上因 401 触发全局登出。
    // 登录/注册本身返回 401 表示密码错误，改密码接口的 401 也不再代表会话过期，
    // 一律登出会把用户从表单上踢出并丢失未保存的输入。
    const isAuthEntry = url.includes('/auth/login') || url.includes('/auth/register');
    const isFormValidation = url.includes('/change-password') || url.includes('/bind-email');

    if (status === 401 && !isAuthEntry && !isFormValidation) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  }
);

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('token'),
  user: null,
  isLoading: false,

  login: async (username, password) => {
    set({ isLoading: true });
    try {
      const { data } = await api.post('/auth/login', { username, password });
      localStorage.setItem('token', data.token);
      set({ token: data.token, user: data.user, isLoading: false });
    } catch (error: any) {
      set({ isLoading: false });
      throw error.response?.data?.error || '登录失败';
    }
  },

  register: async (userData) => {
    set({ isLoading: true });
    try {
      const { data } = await api.post('/auth/register', userData);
      localStorage.setItem('token', data.token);
      set({ token: data.token, user: data.user, isLoading: false });
    } catch (error: any) {
      set({ isLoading: false });
      throw error.response?.data?.error || '注册失败';
    }
  },

  logout: () => {
    localStorage.removeItem('token');
    // 断开广播订阅连接，避免登出后仍以旧令牌维持一条长连接
    resetBroadcastSocket();
    set({ token: null, user: null });
  },

  fetchUser: async () => {
    try {
      const { data } = await api.get('/auth/me');
      set({ user: data.user });
    } catch (error) {
      console.error('获取用户信息失败:', error);
    }
  },
}));
