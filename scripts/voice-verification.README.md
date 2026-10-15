# 语音聊天 —— 实机验证工具

这一组脚本用于**实测**语音链路的真实行为（麦克风是否真的被释放、是否真的在上行音频、音量设置是否真的生效），
而不是靠读代码下结论。它们配合 `scripts/verify-voice-isolation.js`（接口级回归）一起使用。

---

## 为什么需要"实机"验证

接口级测试照不到两类问题，而这两类恰恰都真实发生过：

1. **浏览器安全上下文**：`getUserMedia` 只在 HTTPS 或 localhost 下存在。公网 HTTP 部署时
   浏览器**根本不暴露** `navigator.mediaDevices`，语音功能点了没反应 —— 接口测试完全看不出来。
2. **音频是否真的在发**：只有读 WebRTC 的 `outbound-rtp.bytesSent` 才能回答
   "麦克风此刻是否还在往外发数据"。

> 实测背景：曾用这套工具证明了一个严重缺陷 —— 房主在语音中切到其他页面后，
> 麦克风**仍在持续上传**（切页 6 秒后 `bytesSent` 仍增长 15807 字节、`track.stop()` 一次未调用、
> `AudioContext` 一直 running）。修复后同一工具测得 `bytesSent` 增长为 **0**。

---

## 四个脚本的分工

| 脚本 | 在哪里跑 | 作用 |
|---|---|---|
| `mint-voice-tokens.js` | **服务器** | 建好已邮箱验证的测试账号，并按与 `auth.ts` 一致的方式签发 JWT。绕开登录接口的 15 分钟限流 |
| `local-https-proxy.js` | 本机 | 起一个自签名 HTTPS 反代（HTTP + WebSocket 全转发），把公网 HTTP 站点变成**安全上下文**，让浏览器肯给麦克风 |
| `voice-probe.js` | 本机 | 真 Chrome + CDP 驱动实测：patch `getUserMedia`/`AudioContext`/`RTCPeerConnection`，读 `bytesSent`、`stop()` 调用、`AudioContext` 状态；并对比麦克风音量对上行码率的影响 |
| `clean-voice-probe.js` | **服务器** | 清理实测留下的房间与测试账号（服务端没有 `DELETE /rooms/:id`，房间不会自己消失，会占住建房间额） |

---

## 完整流程

### 1. 服务端：准备账号并签发令牌

```bash
# 在本机执行，APP_DIR 换成你的部署目录（例如 /opt/movie-room）
scp scripts/mint-voice-tokens.js root@<服务器>:<APP_DIR>/server/mint-voice-tokens.js
ssh root@<服务器> "cd <APP_DIR>/server && node mint-voice-tokens.js; rm -f mint-voice-tokens.js"
# 输出形如 TOKENS_JSON={"host":"...","viewer":"..."}
```

把那一行 `TOKENS_JSON=` 后面的 JSON 原样保存到本机 `.tmp-voice/tokens.json`：

```powershell
New-Item -ItemType Directory -Path .tmp-voice -Force | Out-Null
# 把上面的 JSON 内容写进去（单行）
```

> `mint-voice-tokens.js` 必须放在 `server/` 内并从 `server/` 启动：
> 它 require 的是编译产物 `./dist/config`，而 config 用 dotenv 读**当前工作目录**下的 `.env`。

### 2. 本机：拉起 HTTPS 反代

```powershell
# 目标换成你要验证的站点；127.0.0.2 是本机回环地址之一（Chrome 视为安全上下文）
node scripts/local-https-proxy.js http://<服务器IP>:3001 3001 127.0.0.2
```

> ⚠️ 页面请用 **`https://127.0.0.2:3001`** 访问，不要用 `localhost` ——
> Node/Chrome 可能把 localhost 优先解析到 `::1`，连不上本代理。

### 3. 本机：跑实测

```powershell
node scripts/voice-probe.js https://127.0.0.2:3001
```

输出会给出三类客观结论：

```
切页前:        bytesSent=206    stopCalls=0  ctxState=running
切页 6 秒后:   bytesSent=206    stopCalls=2  ctxState=closed
track.stop() 是否被调用 = true      AudioContext 是否被 close = true
仍在发送音频 RTP = false           麦克风音量生效 = true（100%:13668 vs 2%:5232）
```

### 4. 服务端：清理

```bash
scp scripts/clean-voice-probe.js root@<服务器>:<APP_DIR>/clean-voice-probe.js
ssh root@<服务器> "cd <APP_DIR> && node clean-voice-probe.js --users; rm -f clean-voice-probe.js"
```

---

## 环境变量

| 变量 | 用于 | 默认值 |
|---|---|---|
| `VOICE_BASE` | voice-probe | `https://127.0.0.2:3001` |
| `CHROME_PATH` | voice-probe | Windows 常见 Chrome 安装路径 |
| `PROBE_CDP_PORT` | voice-probe | `9222` |
| `PROBE_HOST_USER` / `PROBE_VIEWER_USER` | 三个脚本 | `phvoice1` / `pvvoice1` |
| `PROBE_PASS` | mint / voice-probe | `ProbePass12345` |
| `PROXY_TARGET` | local-https-proxy | `http://127.0.0.1:3001` |
| `PROXY_DEBUG` | local-https-proxy | 置 `1` 打印每条转发的状态码 |

> `PROBE_HOST_USER` / `PROBE_VIEWER_USER` 必须在 **mint、voice-probe、clean 三处保持一致**，
> 否则清理时找不到账号。

---

## ⚠️ 风险与限制（务必知悉）

1. **自签名证书**：`local-https-proxy.js` 用 openssl 现生成自签证书，**仅供本机自动化验证**，
   不要拿它对外提供服务。
2. **测试脚本会关闭 TLS 校验**：`voice-probe.js` 设置了 `NODE_TLS_REJECT_UNAUTHORIZED=0`；
   它只应指向你自己的本机反代。**不要把 `VOICE_BASE` 指向你不信任的站点。**
3. **代理会剥离 `Origin` / `Referer`**：不这么做，浏览器带的 `Origin` 会命中后端 CORS 白名单校验、
   导致静态资源 500。这个行为绕过了 CORS 限制，**只允许指向你自己的服务**。
4. **测试账号是真实账号**：`mint-voice-tokens.js` 会在数据库里建两个普通用户。
   跑完请用 `clean-voice-probe.js --users` 删除（或用 `--users` 之外的参数只清房间）。
5. **依赖 Chrome 与本地端口**：这些脚本**刻意不并入 `npm run verify`**，按需手动运行。

---

## 相关回归测试

| 命令 | 覆盖 |
|---|---|
| `npm run verify:voice-isolation` | 接口级：语音状态绝不跨房间、`voice-join` 的成员校验等（13 项） |
| `npm run verify:public-room` | 接口级：公共房间 / 放映通道全流程（42 项） |
| `npm run verify:public-room-ui` | **真浏览器**：三步弹窗的 DOM 与逐字文案（22 项） |

后两者中的 `-ui` 与本文这一组脚本同类：**依赖真实浏览器，因此不并入默认 verify**。
