# 🎬 Movie Room - 共享观影室

> 最多支持 30 人同时在线观看电影的网页应用

## ✨ 功能特性

- **🏠 房间系统**：创建/加入观影房间，支持密码保护
- **📺 实时观影**：基于 WebRTC P2P 技术，视频流直接从房主传输给观众
- **❤️ 打赏作者**：应用内可查看作者收款二维码，支持微信/支付宝打赏
- **💬 实时聊天**：房间内实时聊天功能
- **🔒 版权友好**：视频数据不经过服务器，房主需有本地片源才能播放
- **🌐 网页应用**：纯浏览器访问，无需安装客户端，后端托管前端页面

## 🏗️ 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Movie Room 架构                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐     WebSocket      ┌──────────────────┐  │
│  │   房主浏览器  │ ◄══════════════► │    信令服务器      │  │
│  │  (网页端)     │     (Socket.io)    │   (Node.js)       │  │
│  └──────┬───────┘                     └────────┬─────────┘  │
│         │ WebRTC P2P                           │           │
│         │                                       │ API      │
│  ┌──────┴───────┐                              ┌┴─────────┐│
│  │ 观众1 浏览器 │                              │  数据库   ││
│  │  (网页端)     │                              │ (SQLite)  ││
│  └──────────────┘                              └──────────┘│
│         ▲                                                   │
│         │ WebRTC P2P                                       │
│  ┌──────┴───────┐                                         │
│  │ 观众2 浏览器 │    ...最多30人                          │
│  │  (网页端)     │                                         │
│  └──────────────┘                                         │
│                                                             │
│  ⚠️ 服务器仅处理信令和业务逻辑，不存储/缓存任何视频数据       │
└─────────────────────────────────────────────────────────────┘
```

## 📁 项目结构

```
movie-room-app/
├── client/                  # 网页前端（React）
│   ├── src/
│   │   ├── main/           # Electron 遗留（可忽略，网页端不使用）
│   │   │   ├── main.js     # Electron 主进程（已废弃）
│   │   │   └── preload.js  # 预加载脚本（已废弃）
│   │   └── renderer/       # React 渲染层（网页端实际入口）
│   │       ├── pages/      # 页面组件
│   │       ├── components/ # 公共组件
│   │       ├── store/      # 状态管理 (Zustand)
│   │       └── styles/     # 样式文件
│   ├── package.json
│   └── vite.config.ts
│
├── server/                  # Node.js 后端服务（同时托管前端静态文件）
│   ├── src/
│   │   ├── config/         # 配置文件
│   │   ├── routes/         # API 路由
│   │   │   ├── auth.ts     # 认证路由
│   │   │   ├── room.ts     # 房间路由
│   │   │   └── user.ts     # 用户路由
│   │   ├── services/       # 业务服务
│   │   │   └── signaling.ts # WebRTC 信令服务
│   │   ├── middleware/      # 中间件
│   │   └── index.ts        # 服务器入口（含前端静态托管）
│   ├── prisma/
│   │   └── schema.prisma   # 数据库模型
│   └── package.json
│
└── package.json             # 根配置（workspace）
```

## 🚀 快速开始

### 环境要求

- Node.js >= 18.0
- npm >= 9.0
- Windows 10/11（目标平台）

### 安装依赖

```bash
# 安装根依赖和所有 workspace 依赖
npm install
```

### 配置环境变量

```bash
# 一键启动脚本会自动生成 server/.env（含随机 JWT 密钥）
# 手动配置时：
cp server/.env.example server/.env

# 生成强随机密钥并填入 JWT_SECRET
openssl rand -hex 32
```

> ⚠️ **安全提示**
> - `JWT_SECRET` 必须使用至少 32 位随机字符串。**切勿把密钥硬编码或提交到代码仓库**——
>   密钥泄露后攻击者可自行签发任意用户的 JWT 冒充管理员。
> - 服务默认仅监听 `127.0.0.1`。如需局域网内其他设备加入观影，需在 `server/.env` 中
>   显式设置 `HOST="0.0.0.0"` 并把 `CLIENT_URL` 配置为对应前端地址（多个用逗号分隔）。
> - 管理员账号**不再通过注册自动获得**。如需管理员，请运行：
>   ```bash
>   cd server
>   ADMIN_PASSWORD="你的强密码" npx ts-node scripts/reset-admin.ts
>   ```
>   注意该脚本会**清空所有数据**，且密码强度不足 12 位时会直接中止。

### 初始化数据库

```bash
cd server

# 方式一（推荐）：使用迁移（与 schema.prisma 完全一致）
npx prisma migrate dev

# 方式二：直接同步 schema 到数据库
npx prisma db push
```

### 开发模式运行

```bash
# 方式一：分别启动后端和前端
npm run dev:server  # 终端1：启动后端服务 (http://localhost:3001)
npm run dev:client  # 终端2：启动前端开发服务器 (http://localhost:5173)

# 方式二：同时启动前后端
npm run dev
```

### 网页端生产模式运行（推荐）

网页版无需 Electron，前端构建成静态文件后由后端同源托管，一个进程即可运行：

```bash
# 构建前端 + 后端，然后启动
npm run start:web
# 或分步：
npm run build
npm run start
```

启动后直接访问 **http://localhost:3001** 即可使用（后端自动托管前端页面）。

> 💡 Windows 用户也可以直接双击项目根目录的 `一键启动.bat`，
> 脚本会自动安装依赖、生成配置、构建前端并启动服务。

## 📖 API 文档

### 认证接口

| 方法   | 路径                   | 说明       |
| ---- | -------------------- | -------- |
| POST | `/api/auth/register` | 用户注册     |
| POST | `/api/auth/login`    | 用户登录     |
| GET  | `/api/auth/me`       | 获取当前用户信息 |

### 房间接口

| 方法    | 路径                      | 说明     |
| ----- | ----------------------- | ------ |
| POST  | `/api/rooms`            | 创建房间   |
| GET   | `/api/rooms`            | 获取房间列表 |
| GET   | `/api/rooms/:id`        | 获取房间详情 |
| POST  | `/api/rooms/:id/join`   | 加入房间   |
| POST  | `/api/rooms/:id/leave`  | 离开房间   |
| PATCH | `/api/rooms/:id/status` | 更新房间状态 |
| GET   | `/api/rooms/my/hosts`   | 我创建的房间 |
| GET   | `/api/rooms/my/joined`  | 我加入的房间 |

## 🔒 版权合规设计

本应用的架构设计遵循「仅作为放映工具」的原则：

### ✅ 合规要点

1. **本地片源要求**：房主必须在本地拥有视频文件才能播放
2. **P2P 传输**：视频流通过 WebRTC 直接从房主传给观众
3. **服务器不存储**：服务器不接收、不存储、不缓存任何视频数据
4. **临时性**：房间解散后，所有连接立即断开，数据不保留

### 数据流向

```
房主本地文件 → [Electron 读取] → [WebRTC 编码] → 
    → [P2P 网络传输] → [观众端解码] → [播放显示]
    
服务器角色：仅提供信令交换（类似"电话接线员"）
```

## 🛠️ 技术栈

### 后端

- **Runtime**: Node.js + TypeScript
- **框架**: Express.js
- **数据库**: SQLite (Prisma ORM)
- **实时通信**: Socket.io (WebRTC 信令)
- **认证**: JWT

### 前端

- **框架**: React 18 + TypeScript
- **构建**: Vite
- **状态管理**: Zustand
- **路由**: React Router v6
- **HTTP**: Axios

### 实时音视频

- **协议**: WebRTC
- **信令**: Socket.io
- **STUN**: Google Public STUN

## 📦 部署发布

网页版前端构建成静态文件后，由后端 Node.js 服务同源托管，无需额外 Web 服务器：

```bash
# 构建前端（产物输出到 client/dist）与后端（输出到 server/dist）
npm run build

# 启动后端（自动托管 client/dist，访问 http://localhost:3001）
npm run start
```

Windows 用户可直接双击根目录 `一键启动.bat`，脚本会自动完成依赖安装、配置生成、
数据库初始化、前端构建与服务启动。

## 🔧 常见问题

### Q: 为什么选择 WebRTC 而不是其他方案？

A: WebRTC 支持 P2P 直连，视频数据不经过服务器，既降低了服务器成本，也符合版权合规要求。

### Q: 30 人同时观看会有性能问题吗？

A: WebRTC Mesh 架构下，房主需要与每个观众建立独立连接。对于 1080p 视频，建议限制在 20 人以内；720p 可以支持 30 人。

### Q: 如何支持更多观众？

A: 可以引入 SFU (Selective Forwarding Unit) 服务器，由服务器转发视频流。但这会增加服务器成本，且需要考虑版权问题。

## 🛡️ 安全与验证

### 安全设计要点

本项目在设计时考虑了几个关键的安全边界：

- **密码存储**：用户密码经 bcrypt（10 轮）加盐哈希；房间密码不出现在任何列表/详情接口中
  （客户端只收到 `hasPassword` 布尔值）
- **令牌机制**：邮箱验证令牌为一次性，落库记录已消费的 jti 防重放；JWT 带 `tokenVersion`，
  改密或封禁后旧令牌立即失效
- **人机验证**：滑块验证码的正确位置**仅保存在服务端**，客户端只拿到带缺口的图片
- **实时通道**：所有 Socket 事件（聊天/语音/投票/信令）均校验房间成员身份，
  播放控制额外校验房主身份
- **网络暴露**：服务默认仅监听回环地址，CORS 采用显式白名单，`trust proxy` 关闭
  （避免通过 `X-Forwarded-For` 伪造 IP 绕过封禁）

### 自动化验证

项目附带三个验证脚本，覆盖安全修复与核心业务流程：

```bash
# 需先启动服务端（npm run dev:server 或 npm start）
npm run verify            # 运行全部验证
npm run verify:security   # 安全修复验证（16 项）
npm run verify:e2e        # 端到端业务流程（15 项）
npm run verify:socket     # Socket 跨房间攻击回归（8 项）
```

---

## 📄 License

MIT License

---

**注意**: 本项目仅供学习交流使用。使用者应当遵守当地法律法规，尊重知识产权。
