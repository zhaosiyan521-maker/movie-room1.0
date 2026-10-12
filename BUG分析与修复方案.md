# Movie Room 项目 Bug 分析与修复方案

> 审计日期：2026-10-12
> 审计范围：`server/src/`（Express + Prisma + Socket.IO）、`client/src/renderer/`（React + WebRTC）
> 文档结构：① 核心问题（本地视频黑屏无声）专项分析 → ② 服务端 Bug 清单 → ③ 客户端 Bug 清单 → ④ 改进建议

---

# 一、核心问题：本地视频传输后观众端黑屏、无声

> **改动范围声明（重要）**
>
> 本问题只涉及**房主选择本地视频文件**的播放链路，该链路为纯浏览器端 WebRTC P2P：
> 房主 `video.captureStream()` → `RTCPeerConnection.addTrack` → 观众 `ontrack` 绑定 `<video>`。
> **视频数据不经过服务器，与 `/api/video-proxy`（网络直链代理）完全无关。**
>
> 因此本章修复 1~4 **只改一个文件**：`client/src/renderer/pages/RoomView.tsx`（修复 4 另含
> `client/src/renderer/store/hostStreaming.ts` 的一处赋值）。**不需要改任何服务端代码，
> 不需要、也不应当改动 `server/src/routes/proxy.ts`，对网络直链播放零影响。**
>
> 两条链路在代码中的分界：`pushLocalFileTracks`（`RoomView.tsx:964-989`）开头即判断
> `usingRemoteUrlRef`，网络直链模式下房主不转发任何视频轨，观众各自加载直链。

## 1.1 现象

- 房主选择**本地视频文件**播放，房主端画面声音正常；
- 观众端能收到"放映开始"的状态（UI 进入播放态），但**看不到画面、听不到声音**；
- 复现规律：
  - 观众**先进入房间、房主后点播放** → 正常；
  - 观众在房主**已开始播放后加入**（含观众中途刷新页面、重连）→ **必现黑屏无声**。

## 1.2 根因：WebRTC 协商竞态——answer 中没有媒体行（m-line）

关键代码：

- 观众收到 `room-joined` 后创建连接：`client/src/renderer/pages/RoomView.tsx:609-613`
- 观众端"无本地轨时兜底发 offer"：`RoomView.tsx:955-957`
- 房主端 offer 处理器：`RoomView.tsx:697-711`
- 房主加轨逻辑：`RoomView.tsx:964-989`（`pushLocalFileTracks`）

完整触发链条：

1. 观众没有麦克风、没有任何本地轨，`getSenders().length === 0`，兜底逻辑发出一个 **0 个 m-line 的空 offer**（仅表达"我想收媒体"）。
2. 房主收到该 offer：
   1. `createPeerConnection()` 内部执行 `pushLocalFileTracks`，此时房主正在播放 → `pc.addTrack(视频轨)`、`pc.addTrack(音频轨)`，同时浏览器把 `negotiationneeded` 事件排入任务队列；
   2. 紧接着 `await pc.setRemoteDescription(观众的空 offer)`——**0 个 m-line 的 offer 无法关联房主刚新增的 transceiver**；
   3. `await pc.setLocalDescription()` 生成 answer——按 SDP 协商规则，**answer 的 m-line 数量必须与 offer 一致，因此 answer 也是 0 个媒体行**。
3. 被推迟的 `negotiationneeded` 此时才触发，进入 `makeOffer()`（`RoomView.tsx:912-930`）：

   ```ts
   if (pc.signalingState !== 'stable') return; // 此刻为 have-remote-offer，直接 return
   ```

   补偿 offer **被静默丢弃**。代码注释假设"offer 处理器会回 answer，无需再发 offer"，但该假设错误——**回出的 answer 不包含刚 add 的轨道**。

4. 双方按"0 媒体行"完成协商：ICE 通道建立但无任何媒体传输，观众端 `ontrack` 永远不触发 → 黑屏 + 无声，且之后无任何补偿。

为什么"房主后点播放"正常：`startLocalFilePlayback`（`RoomView.tsx:1641-1671`）在 PC 处于 `stable` 状态时 `removeTrack + addTrack`，能正常触发一次完整的重新协商。

## 1.3 修复方案

### 修复 1（必做，决定性修复）：answer 发出后补偿一次 offer

`makeOffer` 目前是 `createPeerConnection` 的闭包内函数，先在其定义后挂到 PC 实例上：

```ts
// createPeerConnection 内，makeOffer 定义之后新增：
(pc as any)._makeOffer = makeOffer;
```

修改 offer 处理器（`RoomView.tsx:697-712`）：

```ts
socket.on('offer', async (data: any) => {
  const pc = await createPeerConnection(data.from);
  const polite = isPolite(data.from);
  const makingOffer = makingOfferRef.current.get(data.from) || false;
  const offerCollision = makingOffer || pc.signalingState !== 'stable';
  const ignoreOffer = !polite && offerCollision;
  if (ignoreOffer) return;

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    await pc.setLocalDescription();
    socket.emit('answer', { target: data.from, answer: pc.localDescription });

    // 补偿协商：若本端携带本地轨（房主推流 / 麦克风），而对方的 offer
    // 没有 m-line，则上面的 answer 不包含这些轨道。此刻已回到 stable，
    // 必须补发一次 offer，否则媒体轨永远无法建立（观众黑屏无声根因）。
    if (pc.getSenders().some(s => s.track)) {
      setTimeout(() => {
        if (pc.signalingState === 'stable' && pc.connectionState !== 'closed') {
          void (pc as any)._makeOffer?.();
        }
      }, 0);
    }
  } catch (err) {
    console.error('处理 offer 失败:', err);
  }
});
```

说明：`makeOffer` 内部已有的 `makingOfferRef` 防抖与 `signalingState !== 'stable'` 守卫保留；双方同时发 offer 的 glare 由现有 `isPolite` 机制处理。

### 修复 2（推荐，从根上规避）：观众端声明 recvonly

让观众的第一个 offer 就携带 m-line，房主 `addTrack` 可直接关联，不再依赖二次协商。在 `createPeerConnection` 内（`addLocalTracksTo(pc)` 之前）新增：

```ts
// 观众端 + 本地文件 WebRTC 模式：声明只收不发的收发器
if (!isHostRef.current && !usingRemoteUrlRef.current) {
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
}
```

修复 1 仍保留，作为麦克风动态加轨等场景的兜底。

### 修复 3（必做）：autoplay 被浏览器拦截时的兜底

即使协商成功，`handleRemoteTrack` 中的 `el.play().catch(() => {})`（`RoomView.tsx:1087-1088`）会吞掉浏览器自动播放策略拦截（无用户手势时带声音自动播放会被拒绝），这是黑屏的第二来源。改为：

```ts
el.play().catch(() => {
  el.muted = true;          // 静音态允许自动播放，先保证有画面
  el.play().catch(() => {});
  setNeedUnmute(true);      // 渲染"点击开启声音"浮层
});
```

新增浮层 UI（观众视频区），点击时执行：

```ts
const unlockAudio = () => {
  const el = remoteVideoRef.current;
  if (!el) return;
  el.muted = false;
  el.play().catch(() => {});
  setNeedUnmute(false);
};
```

### 修复 4（建议）：消除双重播放回声 + 复用 captureStream

- `RoomView.tsx:1091-1099`：视频轨与音频轨属于**同一条 MediaStream**，该流已绑给 `<video>` 元素播放（含声音），audio 分支又 `new Audio()` 播放同一流 → 双重声音/回声。audio 分支应仅处理纯语音流：

  ```ts
  } else if (track.kind === 'audio') {
    // 视频流自带的音轨已由 <video> 播放，跳过，避免回声
    if (stream.getVideoTracks().length > 0) return;
    // ...仅对纯麦克风语音流创建 Audio 元素
  }
  ```

- `getVideoCaptureStream`（`RoomView.tsx:1001-1009`）每次调用都产生新的 `captureStream()` 实例；而 `HostSession.captureStream`（`store/hostStreaming.ts:34`）从未被赋值，`destroyHostSession` 停止的是空引用。应在开播成功时缓存并全局复用：

  ```ts
  // startLocalFilePlayback 中取得 stream 后：
  if (hostSessionRef.current) hostSessionRef.current.captureStream = stream;
  // getVideoCaptureStream 优先返回 session.captureStream
  ```

## 1.4 验证步骤

1. 房主创建房间并选择本地 mp4，点击开始播放；
2. 观众 A 在播放开始**之后**加入 → 应立即出现画面与声音（核心场景）；
3. 观众 B 播放中途刷新页面 → 重连后自动恢复画面声音，进度与房主一致；
4. 房主播放中暂停/继续/拖动进度条 → 观众端正确跟随；
5. 观众首次进入若浏览器拦截自动播放 → 出现"点击开启声音"浮层，点击后有声；
6. 观众加入语音再退出 → 不出现双重声音；房主本地静音 → 观众仍能听到声音。

---

# 二、服务端 Bug 清单

| 编号 | 严重度 | 位置 | 问题与影响 | 修复建议 |
|---|---|---|---|---|
| S1 | 低（安全，**默认部署下可接受**） | `server/src/routes/proxy.ts:198` | SSRF 重定向绕过：`fetch(..., { redirect: 'follow' })` 使内网校验只作用于首跳，公网 URL 302 跳内网地址可穿透防护。**但注意两点权衡**：① 应用默认仅监听 `127.0.0.1`（`index.ts:103-105`），非公网部署时该风险实际不可达；② **绝不能简单改成 `redirect: 'manual'`**——大量正常视频直链本身就是 302 跳转到真实 CDN 地址，改 manual 后代理返回 3xx 空响应，**网络直链播放会直接失效** | 仅当确需 `HOST=0.0.0.0` 公网部署时再处理：自行实现"逐跳跟随"（每跳读取 `Location` → 对新 URL 重新执行协议/凭据/内网 IP 校验 → 继续请求），**校验通过后仍要正常跟随跳转**，限制最大跳数（如 3）。本地/局域网部署保持现状即可 |
| S2 | 低（安全） | `proxy.ts:67-75` | DNS rebinding（TOCTOU）：先 `dns.lookup` 校验私网，`fetch` 时再次解析 DNS，两次结果理论上可不同。同样仅在公网部署时有意义 | 用 undici `connect.lookup` 自定义解析把 IP 钉死，或解析后直连 IP + 手动设置 Host/SNI。实现成本较高，默认回环部署可不做 |
| S3 | 低（安全，**默认不修，强行修会破坏播放**） | `server/src/index.ts:78` | `/api/video-proxy` 无鉴权、无限流，公网部署时理论上可被当开放代理滥用；本地回环部署无此风险。**但禁止直接套用普通 API 限流**：mp4 拖拽/缓冲会发大量 Range 请求，HLS 每个 .ts 分片都是一个请求（一部电影数百上千次、短时突发），常规阈值（每分钟几十次）会立刻误杀，分片收到 429 → 卡顿/无法播放；且 `<video>` 无法携带 Bearer 令牌，"要求登录"也不可行 | 本地/局域网部署：**不做**。确需公网部署时：只能设计媒体专用限流——高两个数量级的阈值 + 突发桶（burst）、按 IP 单位时间总流量/总字节而非请求数限制、对同一 url 的分片请求宽松处理；并配合服务器出带宽上限。实施前必须用真实 HLS 片源压测 |
| S4 | 中 | `server/src/routes/room.ts:390-417` | 加入房间"先 count 再 create"无事务：并发加入可突破 `maxViewers` 上限；同一用户并发请求触发 P2002 唯一约束冲突 → 返回 500 | 使用 `prisma.$transaction`，或在 create 的 catch 中识别 P2002 返回 `alreadyMember: true` |
| S5 | 中 | `server/src/routes/auth.ts:202-240` | 注册时先消费邮箱验证凭据再建用户；建号失败（用户名/邮箱并发冲突返回 409）后凭据**没有还回**——注释写了"需把令牌还回"但代码未实现，用户被迫重新走一遍邮箱验证 | 将"消费凭据"移到 `user.create` 成功之后；或 create 失败时回滚消费（删除 UsedToken 记录） |
| S6 | 中 | `server/src/routes/admin.ts:179-195`、`255-264` | 封禁/强制注销房主时只改数据库（房间置 ENDED、删成员），**不广播 `room-dissolved`**，也不清理信令内存（`roomUsers`、`roomPlaybackStates`、`kickVotes`）→ 在线观众滞留幽灵房间、画面冻结无提示 | 复用 `dissolveRoom(roomId, { io })` 处理其活跃房间，保证广播与内存清理一致 |
| S7 | 低 | `room.ts:201-209` | 创建房间房间名查重为 check-then-create，并发可建出同名活跃房间（P2002 依赖数据库无唯一约束兜底） | catch 中识别唯一冲突；或在 (name, status 活跃) 层增加业务约束 |
| S8 | 低 | `server/src/services/signaling.ts:383-389` | `host-start-play` 落库 `currentMovie` 不截断（广播给观众截 200 字符，写库无上限），与 `PATCH /rooms/:id/status` 的 200 字符校验不一致 | 落库前统一 `.slice(0, 200)` |
| S9 | 低 | `server/src/middleware/rateLimit.ts` | 限流 key 数超过 `MAX_KEYS` 时**清空整个 Map**，等于所有 IP 同时获得限流豁免；攻击者可高频伪造 IP 主动触发 | 超限后改为 LRU 淘汰最旧 key，或定期清理 + 拒绝新增 |
| S10 | 低 | `server/src/routes/user.ts:58-61`、`99-102` | 昵称/用户名唯一性同样是 check-then-update/create，并发下靠数据库异常兜底，但 `update` 未捕获唯一冲突 → 偶发 500 | catch P2002 返回 409 友好提示 |

---

# 三、客户端 Bug 清单

| 编号 | 严重度 | 位置 | 问题与影响 | 修复建议 |
|---|---|---|---|---|
| C1 | **高** | `client/src/renderer/pages/RoomView.tsx:697-711`、`912-930`、`955-957` | WebRTC 协商竞态：播放中途加入的观众收到 0 m-line 的 answer，媒体轨永不建立 → 黑屏无声（详见第一章） | 按修复 1 + 修复 2 实施 |
| C2 | 中 | `RoomView.tsx:1091-1099` | 含音频轨的视频流同时绑定 `<video>` 和 `new Audio()` 播放 → 双重声音/回声 | audio 分支跳过含视频轨的流（见修复 4） |
| C3 | 中 | `RoomView.tsx:1087-1088` | 观众 `play()` 失败被静默吞掉，浏览器自动播放策略拦截时永久黑屏无提示 | 静音自动播放兜底 + 解锁声音浮层（见修复 3） |
| C4 | 中 | `RoomView.tsx:1209`（`startSpeakingDetection`） | 说话检测闭包捕获 `micOn` state：用户关闭麦克风再重新打开后，检测函数里的 `micOn` 永远是旧值 `false`，说话高亮永久失效，需退出语音重进 | 使用 `micOnRef`（同步镜像）替代闭包 state |
| C5 | 低 | `RoomView.tsx:1001-1009`、`store/hostStreaming.ts:34` | `captureStream()` 被反复调用产生多个流实例；`session.captureStream` 从未赋值，`destroyHostSession` 停的是空引用，旧轨道无法被正确停止 | 开播时缓存到 `session.captureStream` 并全局复用（见修复 4） |
| ~~C6~~ | **撤销，不修复** | `RoomView.tsx:783-798` | ~~progress-sync 纠偏未判断 duration/seekable~~。经评估此建议**弊大于利，予以撤销**：① 该处理器是本地 WebRTC 与网络直链（mp4/HLS）观众的**共用代码路径**，加入 `Number.isFinite(duration)` 会让直播 HLS（`duration=Infinity`）永久跳过纠偏，加入 `seekable.length > 0` 会在 HLS/大 mp4 元数据与缓冲建立初期（`seekable` 为空、`duration=NaN`）跳过纠偏，导致房主/观众进度脱节——**直接影响网络直链播放**；② 现有 5 秒保护期 + 3 秒冷却 + `el.seeking`/`readyState < 2` 检查已足够；③ 原担忧（实时轨 seek 行为差异）仅为推测，无实际故障证据 | **不改代码，保持现状**。如未来证实本地文件模式确有 seek 异常，修复时必须用 `!usingRemoteUrlRef.current` 把新逻辑限定在本地文件模式，绝不能动网络直链分支 |

---

# 四、改进建议（非功能性 Bug）

1. **引入标准 Perfect Negotiation 模式**
   当前 `polite/impolite + 直接 return` 为简化版协商，glare 时不做 rollback，偶发 `InvalidStateError` 后协商链条断裂只能靠重连恢复。按 WebRTC 官方推荐模式实现（`makingOffer`、`ignoringOffer`、`isSettingRemoteAnswerPending` + rollback），约 20 行代码可系统性消灭此类竞态。

2. **video-proxy 安全加固（仅公网部署时需要，与本地文件播放问题无关，且须谨慎避免误伤播放）**
   S1~S3 均为 `/api/video-proxy`（网络直链代理）的安全加固项，**默认 127.0.0.1 回环部署下无需处理**。
   两条红线：
   - S1 不可简单改成 `redirect: 'manual'`，否则依赖 302 跳转 CDN 的正常直链全部失败；正确做法是"逐跳校验、校验通过后继续跟随"；
   - S3 不可套用普通 API 的请求数限流，否则 Range/HLS 分片请求会被 429 打断；只能做按流量统计的媒体专用限流，且上线前必须用真实 HLS 片源压测。

   本地文件播放走 WebRTC P2P，不经此代理，永远不需要改它。

3. **加入房间接口事务化（S4）**
   `prisma.$transaction` 内完成"计数 + 建成员"，并把 P2002 转换为幂等成功响应。

4. **管理员处置逻辑复用 dissolveRoom（S6）**
   封禁/强制注销房主时统一走 `dissolveRoom(io)`，保证数据库、信令内存、客户端广播三处状态一致。

5. **观众端连接状态可视化**
   展示 WebRTC `iceConnectionState`（连接中 / 已连接 / 失败）与"未收到画面"诊断提示，黑屏类问题可由用户自判：是协商失败、网络不通，还是自动播放被拦截。

6. **注册流程凭据消费时机调整（S5）**
   建号成功后再消费验证凭据，失败时不浪费用户的验证链接。

---

# 五、修复优先级建议

> 解决"本地文件观众黑屏无声"只需做 P0 + P1 的**客户端部分**，全部改动集中在
> `RoomView.tsx`（加 hostStreaming.ts 一行），**不涉及任何服务端文件，不影响网络直链播放**。

| 优先级 | 事项 | 对应编号 | 改动位置 |
|---|---|---|---|
| P0（立即） | WebRTC 协商竞态修复（补偿 offer + recvonly） | C1 / 修复 1、2 | 仅 `RoomView.tsx` |
| P0（立即） | 观众端自动播放兜底与声音解锁浮层 | C3 / 修复 3 | 仅 `RoomView.tsx` |
| P1（本周） | 双重声音回声、captureStream 复用、麦克风检测闭包 | C2、C4、C5 / 修复 4 | `RoomView.tsx` + `hostStreaming.ts` 一处 |
| P2（排期，独立事项） | 加房事务、注册凭据回滚、封禁广播一致性 | S4、S5、S6 | 服务端，与黑屏问题无关 |
| P3（按需） | Perfect Negotiation、连接状态可视化、其余低危项 | S2、S7-S10 | 客户端/服务端均有 |
| 已撤销 | progress-sync 加 duration/seekable 判断（会误伤网络直链/HLS 纠偏） | ~~C6~~ | 不改，保持现状 |
| 暂不处理 | video-proxy 相关加固 | S1、S3 | 仅公网部署（`HOST=0.0.0.0`）时再评估；本地部署不动，避免误伤网络直链播放 |
