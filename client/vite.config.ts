import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 相对路径，适配 Electron 打包后的 file:// 协议加载
  base: './',
  server: {
    port: 5173,
    // 端口被占用时直接报错，而不是静默递增到 5174
    // （否则 Electron 仍会加载 5173 导致白屏，且难以排查）
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
