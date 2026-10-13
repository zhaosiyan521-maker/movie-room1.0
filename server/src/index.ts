import express from 'express';
import cors from 'cors';
import path from 'path';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

import { authRouter } from './routes/auth';
import { roomRouter } from './routes/room';
import { userRouter } from './routes/user';
import { adminRouter } from './routes/admin';
import { announcementsRouter } from './routes/announcements';
import { broadcastRouter } from './routes/broadcast';
import { proxyRouter } from './routes/proxy';
import { setupSocketHandlers } from './services/signaling';
import { ensureSeedAdmin } from './services/seedAdmin';
import { config } from './config/index';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// 真实 IP 来源：本应用为本地桌面端直连，不位于反代之后，
// 故关闭 trust proxy，避免攻击者通过 X-Forwarded-For 伪造 IP 绕过封禁。
app.set('trust proxy', false);

// 基本安全响应头（不引入额外依赖，手动设置关键项）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// CORS 白名单：仅允许配置的前端来源。
// 注意不能简单用 '*' + credentials:true（浏览器会拒绝），必须显式列出。
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, ok?: boolean) => void) => {
    // 允许无 Origin 的请求（如 Electron file:// 加载、curl、同源请求）
    if (!origin) return callback(null, true);
    if (config.allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('CORS: 该来源不被允许'));
  },
  credentials: true
};

app.use(cors(corsOptions));

// Socket.io 配置（同样使用白名单）
const io = new Server(httpServer, {
  cors: {
    origin: config.allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// 注意：全局不再设置大体积 JSON 限制。图片上传接口在 room 路由中单独放开到 20mb，
// 其余接口仅使用默认 100kb，降低大请求导致的资源耗尽风险。

// 静态文件：房间图片
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), {
  maxAge: '7d',
  index: false,
  dotfiles: 'deny'
}));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API 路由
app.use('/api/auth', authRouter);
app.use('/api/rooms', roomRouter);
app.use('/api/users', userRouter);
app.use('/api/admin', adminRouter);
// 公告（面向登录用户）：首屏弹窗 + 按用户维度「仅显示一次」的已读记录
app.use('/api/announcements', announcementsRouter);
// 广播（面向所有访客）：大厅 / 房间页顶部滚动条的数据兜底读取接口（无需登录）
app.use('/api/broadcast', broadcastRouter);
// 网络视频直链代理（绕过跨域/防盗链）：必须在带鉴权的路由之外，因 <video> 无法附带 Bearer 令牌
app.use('/api', proxyRouter);

// 设置 Socket.io 信令处理
setupSocketHandlers(io);

// 首次启动确保存在初始管理员账号（用户名/密码默认 admin，已存在则跳过）
ensureSeedAdmin().catch((e) => console.error('初始化管理员账号失败:', e));

// ===== 网页端静态托管（生产模式）=====
// 前端构建产物位于 ../client/dist。存在时由后端直接托管，
// 使网页端只需一个后端进程即可运行（无需 vite dev server / Electron）。
// 开发模式仍用 vite dev server（5173）+ /api 代理，此处托管逻辑不生效。
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (require('fs').existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: 'index.html' }));
  // SPA 回退：非 /api、/uploads 的路径全部返回 index.html，交给前端路由处理
  app.get(/^\/(?!api\/|uploads\/|socket\.io\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  console.log(`🌐 前端静态资源已托管：${clientDist}`);
}

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = config.host;

// 默认仅监听本机回环地址，避免 API 暴露到局域网/公网。
// 如需局域网共享观影，请在 .env 中显式设置 HOST=0.0.0.0 并配置 CLIENT_URL 白名单。
httpServer.listen(PORT, HOST, () => {
  console.log(`🎬 Movie Room Server running on ${HOST}:${PORT}`);
  console.log(`📡 WebSocket signaling ready`);
  console.log(`🔗 API: http://localhost:${PORT}/api`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(`⚠️  服务已监听 ${HOST}（非回环地址），同一网络内的其他设备可能访问此服务，请确认网络环境可信`);
  }
});

export { io };
