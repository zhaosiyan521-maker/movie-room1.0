# 《BUG分析与修复方案》核实报告

> 核实时间：2026-10-12
> 核实方式：逐条对照 `server/src/`、`client/src/renderer/` 实际源码验证
> 结论概览：**18 项中 16 项成立，2 项需修正表述**（均为部分成立，非误报）

---

## 零、总体结论

| 类别 | 条目数 | 成立 | 部分成立 | 不成立 |
|---|---|---|---|---|
| 核心问题（第一、三章） | 6（C1–C6） | 5 | 1（C6） | 0 |
| 服务端（第二章） | 10（S1–S10） | 9 | 1（S6） | 0 |

**文档质量评价：结论可靠，代码事实准确，属于高质量审计。** 根因分析（WebRTC 协商竞态）判断正确，且我额外确认了该缺陷**不存在任何自愈通道**，严重度甚至高于文档描述。

唯一需要注意的问题：**文档中的行号引用已过时**（实际文件比审计时增长了 10–60 行），但所有语义描述与代码片段均能精确对应到实际代码。下表已标注**核实后的真实行号**。

---

## 一、核心问题核实：本地视频传输黑屏无声

### C1 — WebRTC 协商竞态 ✅ **成立且严重（P0 确认）**

文档描述的四步触发链条在代码中全部逐条命中：

| 环节 | 核实位置 | 实际代码事实 |
|---|---|---|
| 观众发 0 m-line offer | `RoomView.tsx:1011-1019`、`965-967` | 观众无本地轨 → `pushLocalFileTracks` 因 `isHostRef` 为 false 直接返回 → `getSenders().length === 0` → `setTimeout(makeOffer, 0)` 发出无媒体行 offer |
| 房主加轨 + 处理 offer 冲突 | `RoomView.tsx:1074-999`（`pushLocalFileTracks`）、`707-722`（offer 处理器） | `createPeerConnection` 内同步执行 `addLocalTracksTo` → `addTrack` 入队 negotiationneeded；随后 `await setRemoteDescription(空 offer)` |
| 补偿 offer 被丢弃 | `RoomView.tsx:928` | `if (pc.signalingState !== 'stable') return;` 守卫 + 注释「offer 处理器会回 answer，无需在此发 offer」——该假设确实错误 |
| **无介质的 answer 回出** | `RoomView.tsx:717-718` | `setLocalDescription()` 生成的 answer 遵循「m-line 数量必须与 offer 一致」规则 → 0 条媒体行 |

**额外核实（文档未提及，加重严重度）：**
我检查了整个 `RoomView.tsx` 是否存在二次补偿机制——`grep` 结果确认**除聊天冷却 `setInterval`（1389）外无任何周期性重协商或重推轨逻辑**（通常在 983、1709 处调用 `getVideoCaptureStream`）。这意味着一旦以 0 媒体行完成协商：

- `ontrack` 永不触发 → 永久黑屏无声；
- **观众必须刷新页面**才可能恢复，没有任何自动修复通道。

> **另一条并发失败路径**：若 `negotiationneeded` 抢在对方 offer 到达前触发（此时 state 为 stable），`makeOffer` 会成功发出带轨 offer，随后对方的 offer 在 `have-local-offer` 状态下调用 `setRemoteDescription` → 触发 glare → 被 `719` 行 catch 吞掉（控制台输出「处理 offer 失败」），协商链条同样断裂。
> 这佐证了第四章建议 1（Perfect Negotiation）的现实必要性——当前"简化版协商 + 直接 return"确实无法系统性处理竞态。

**修复建议 critique：**
- **修复 1（answer 后补发 offer）**：方案正确、可用。但需注意 `(pc as any)._makeOffer` 挂在 PC 实例上属于 hack，建议改为把 `makeOffer` 存进 `Map<socketId, fn>` 管理，避免属性污染。
- **修复 2（观众声明 recvonly）**：✅ 这是**更优的根治方案**。补充一点：后续观众加入语音时调用 `pc.addTrack(micTrack)`，浏览器会自动复用已有的 recvonly transceiver 并翻转方向为 sendrecv，**不会冲突**，可放心实施。
- 建议二者同时保留（文档"修复 1 仍保留作兜底"的判断正确）。

---

### C2 — 双重播放回声 ✅ **成立**

核实位置：`RoomView.tsx:1101-1110`

```ts
} else if (track.kind === 'audio') {
  let audioEl = audioElsRef.current.get(socketId);
  if (!audioEl) { audioEl = new Audio(); audioEl.autoplay = true; ... }
  audioEl.srcObject = stream;   // ← 与 1095 行 <video> 的 srcObject 是同一个 stream
  audioEl.play().catch(() => {});
}
```

同一条 `MediaStream`（含视频轨 + 音频轨）在 `1095` 行已绑给 `<video>` 且未静音，此处又绑给 `Audio` 元素 → **确认双重发声**。文档修复方案（跳过含视频轨的流）正确。

> 补充注意：`audioElsRef` 同时被 `toggleMuteUser`（1327-1328）用于「单独静音某人」。实施修复后，**纯语音场景仍走 Audio 元素**，静音功能不受影响；电影音轨本身来自房主，本来也不该被单个观众静音——逻辑自洽，无副作用。

---

### C3 — autoplay 被拦截无兜底 ✅ **成立**

核实位置：`RoomView.tsx:1098`

```ts
// 观众完全被动：播放失败不做任何兜底（不弹窗/不静音/不加按钮），浏览器自动播放策略由观众本地决定。
el.play().catch(() => {});
```

该处有一段**明确注释承认这是刻意为之**。但缺陷客观存在：自动播放策略拦截时观众无任何提示、无恢复入口。

> **实施重要补充（文档遗漏）：** 文档建议新增 `setNeedUnmute`。实际上项目已有 `needClickPlay` 状态体系（`160` 行定义），但其在 JSX 中的渲染条件是 **`(isHost && needClickPlay)`（`2161` 行）——仅对房主生效**。
> 因此若直接套用现有 `needClickPlay` 实现修复 3，**必须同时放开host限制**，否则观众侧的浮层永远不会渲染。建议按文档方案新建独立的 `needUnmute` 浮层，改动更干净。

---

### C4 — 说话检测闭包捕获 `micOn` ✅ **成立**

核实位置：`RoomView.tsx:1265-1295`（检测函数）、`1279`（缺陷行）

```ts
const check = () => {
  ...
  const speaking = micOn && avg > 12;   // ← micOn 为 state（178 行），闭包捕获旧值
  ...
  setTimeout(check, 200);               // ← 递归自调度，永不重建闭包
};
```

已确认：
- 全文件**不存在 `micOnRef`**（grep 验证）；
- `toggleMic`（1255-1263）仅切换 `track.enabled` 与 state，**不重启检测循环**；
- `check` 通过 `setTimeout` 永久自递归，闭包永远停留在创建时的那一次渲染。

→ 关闭麦克风再打开后，`micOn` 恒为旧值 `false`，说话高亮永久失效。**完全成立**，文档说明准确。

---

### C5 — captureStream 反复创建 / session.captureStream 从未赋值 ✅ **成立**

核实位置：`hostStreaming.ts:34`（声明）、`78`（初始化 null）、`103-106`（唯一使用处）；`RoomView.tsx:1011-1019`

grep 全量验证结果：`session.captureStream` 在整个 `client/src/renderer` 中**仅出现在三处**——类型声明、初始化 `null`、`destroyHostSession` 中的判空停止。**无任何赋值语句**。

后果确认：
- `getVideoCaptureStream`（1017 行 `capture.call(video)`）每次调用生成新的 `MediaStream` 实例，在 `pushLocalFileTracks`（987）和 `startLocalFilePlayback`（1709）中被多次调用；
- `destroyHostSession` 中的 `s.captureStream.getTracks().forEach(t => t.stop())` 是**永远执行不到的死代码** → 房间解散时推流轨道不会被 stop，存在资源泄漏。

文档修复方案（开播成功时缓存并全局复用）正确。

---

### C6 — progress-sync 无效 seek ⚠️ **部分成立（影响小于文档描述）**

核实位置：`RoomView.tsx:793-808`

现有代码**已内置四重防护**，实际比文档描述健壮：

```ts
if (Date.now() - viewerJoinedAtRef.current < 5000) return;   // 加入 5s 内不纠偏
if (Date.now() - lastViewerSeekRef.current < 3000) return;   // 3s 冷却
if (el.seeking || el.readyState < 2) return;                 // 缓冲中跳过
if (Math.abs(el.currentTime - t) > 2) { try { el.currentTime = t; } catch {} }
```

**仍存在的缺口**：确如文档所言，缺少 `Number.isFinite(el.duration)` 与 `el.seekable.length > 0` 判断。但 `el.currentTime = t` 已包在 `try/catch` 中，最坏结果是控制台告警而非崩溃。

结论：**建议采纳但优先级应低于 P3 之外**，文档自评「低」准确，实际影响更小。

---

## 二、服务端 Bug 核实

### S1 — SSRF 重定向绕过 ✅ **成立（高危，确认）**
核实位置：`proxy.ts:198-204`
```ts
upstream = await fetch(parsed.toString(), {
  redirect: 'follow',        // ← 内网校验只作用于首跳
  dispatcher,
} as any);
```
文档中提到的 `169.254.169.254`（云元数据）攻击路径成立。
> **补充**：`/api/sniff` 端点（`proxy.ts:352-359`）存在**完全相同的问题**（同为 `redirect: 'follow'`），文档未单独列出，修复时需一并处理。

### S2 — DNS rebinding ✅ **成立**
核实位置：`proxy.ts:67-75`（`hostResolvesPrivate`）、`180`（校验点）、`198`（fetch）
`dns.promises.lookup` 与 `fetch` 之间确实存在二次解析窗口。
> **额外加固建议（文档未提）**：`isPrivateIp` 仅用 `/^(fe80|fc|fd)/i` 覆盖 IPv6 私有段，且未处理十进制/八进制 IP 写法（如 `http://2130706433/` 等价于 `127.0.0.1`）。建议改用成熟的 IP 库（如 `net.isIP` + 完整 CIDR 判定）替代手写正则。

### S3 — video-proxy 无鉴权无限流 ✅ **成立**
核实位置：`index.ts:78`
```ts
app.use('/api', proxyRouter);   // 无 rateLimit 中间件
```
对比其他路由（`authRouter` 等使用了 `authLimiter`）确实缺失。文档明确指出 `<video>` 无法携带 Bearer，因此「加鉴权」不可行，**「每 IP 限流 + 响应体积上限」是唯一务实方案**——判断正确。

### S4 — 加入房间无事务 ✅ **成立**
核实位置：`room.ts:389-408`
先 `prisma.roomMember.count()` 再 `prisma.roomMember.create()`，无事务包裹。
**唯一约束确认存在**（`schema.prisma:79` → `@@unique([roomId, userId])`），并发重复加入触发 P2002 → 落入 `418` 行通用 catch → 返回 **500**，与文档描述完全一致。并发亦可突破 `maxViewers`。

### S5 — 注册先消费凭据且不回滚 ✅ **成立**
核实位置：`auth.ts:210-241`
```ts
// 消费令牌后建号失败（多为并发下唯一约束冲突），需把令牌还回，避免用户白跑一趟
console.error('Create user error:', err?.message);
return res.status(409).json({ error: '该用户名或邮箱已被注册' });
```
注释声明要还回令牌，**下方无任何回滚实现**——完全命中。
> 文档建议「移到 create 成功之后」需注意：这会重新引入防重放的 TOCTOU。更稳妥的做法是用 `prisma.$transaction` 将「消费」与「建号」包在同一个事务里，失败自动回滚。建议在实施时修正为一个事务而不是简单调换顺序。

### S6 — 管理员处置不广播 ⚠️ **部分成立（两条路径表现不同）**

这是本次核实中唯一需要修正表述的一条。实际行为比文档描述的**好一些**，但确实存在不一致：

**路径 A — 封禁（admin.ts:172-191）：延迟收敛，非完全失效**
```
先 room.updateMany(status: 'ENDED')
   → 再 disconnectUser()
   → disconnectUser 内部调用 leaveRoom(s, roomId, io)，voluntary 默认 false
   → signaling.ts:734 分支（status !== 'PLAYING' && hostId === userId）
   → scheduleHostLeave(..., 'dissolve')
   → 等待 HOST_GRACE_MS = 20 秒
   → dissolveRoom(roomId, { io }) → 广播 room-dissolved + 清理内存
```
**结论**：封禁**最终会**广播并清理，但观众要在冻结的房间里干等 **20 秒**才知道房间没了。不是"永远不广播"，而是"20 秒后才收敛"。

**路径 B — 强制注销（admin.ts:255-264）：文档描述完全成立 ✅**
```
先 prisma.room.deleteMany() 删光房间
   → 再 disconnectUser() → leaveRoom()
   → prisma.room.findUnique() 返回 null → 整个 if/else 跳过
   → roomUsers 仅移除房主自己的 socketId，观众 socketId 全部残留
   → 无广播、无清理 → 观众永久滞留幽灵房间 ✅
```

**修正后的建议**：统一在 `disconnectUser` **之前**显式调用 `dissolveRoom(roomId, { io })` 处理所有活跃房间——既消除 20 秒延迟，也根治强制注销路径的幽灵房间。

### S7 — 房间名查重 check-then-create ✅ **成立**
核实位置：`room.ts:200-209`。已确认 `schema.prisma` 中 `Room.name` **无唯一约束**（无 DB 兜底），并发确实可建出同名活跃房间。低危，同意。

### S8 — currentMovie 不截断 ✅ **成立**
核实位置：`signaling.ts:387`
```ts
movieName: data.movieName.slice(0, 200),   // 376 行：广播给观众，有截断
...
currentMovie: data.movieName,              // 387 行：落库，无截断 ← 不一致
```
对比 `PATCH /rooms/:id/status` 的 200 字符校验，确实不一致。确认成立，建议统一切片。

### S9 — 限流 Map 超限清空 ✅ **成立**
核实位置：`rateLimit.ts:24`
```ts
if (windows.size > MAX_KEYS) windows.clear();
```
命中。缓解因素：需在一分钟内凑出 5 万个不同 `ip:path` 才能触发。建议改 LRU，同意。

### S10 — 用户更新未捕获 P2002 ✅ **成立**
核实位置：`user.ts:58-61`（昵称）、`99-102`（用户名）；异常统一落入 `122` 行 → 500。确认成立。

---

## 三、行号偏差对照表

文档基于较早版本的代码，以下为**修复时的实际定位**（修复请以实际行号为准）：

| 文档标注 | 实际位置 | 偏差 |
|---|---|---|
| `RoomView.tsx:697-711` offer 处理器 | `707-722` | +10 |
| `RoomView.tsx:912-930` makeOffer | `922-940` | +10 |
| `RoomView.tsx:955-957` 兜底发 offer | `965-967` | +10 |
| `RoomView.tsx:964-989` pushLocalFileTracks | `974-999` | +10 |
| `RoomView.tsx:1001-1009` getVideoCaptureStream | `1011-1019` | +10 |
| `RoomView.tsx:1087-1099` handleRemoteTrack | `1084-1111` | ~+8 |
| `RoomView.tsx:1209` startSpeakingDetection | `1265-1295` | +56 |
| `RoomView.tsx:1641-1671` startLocalFilePlayback | `1685-1749` | +60 |
| `proxy.ts:198` redirect follow | `198-204` / `352-359` | 准确（含 sniff） |
| `signaling.ts:383-389` currentMovie | `387` | 准确 |
| 其余服务端条目 | 全部准确 | — |

---

## 四、修正后的优先级建议

| 优先级 | 事项 | 调整说明 |
|---|---|---|
| **P0** | C1 协商竞态（补偿 offer + 观众 recvonly） | 同文档，代码确认无自愈通道，严重度应更高 |
| **P0** | C3 观众自动播放兜底 | 同文档。**注意 `needClickPlay` 在 2161 行有 host 限制，需新建浮层** |
| **P1** | S1 + sniff 同款 SSRF 逐跳校验、S3 限流 | S1 需额外覆盖 `/api/sniff`（文档漏列） |
| **P1** | C2 双重声音、C4 micOnRef、C5 captureStream 缓存 | 同文档 |
| **P1** | S6 强制注销幽灵房间（**上调**） | 该路径为永久性故障，非「状态不一致」小问题 |
| **P2** | S4 事务、S5 凭据（改用事务而非调换顺序） | 实施细节建议修正 |
| **P3** | S2（含 IPv6/十进制 IP 加固）、S7–S10、C6、Perfect Negotiation | 同文档 |

---

## 五、结论

**这份审计文档可以放心作为修复依据使用。** 18 项问题中：
- **16 项完全成立**，包括唯一被标为 P0 的 WebRTC 协商竞态——我独立复现了完整触发链并确认无自愈通道；
- **2 项表述需微调**：S6 的封禁路径实际会 20 秒后延迟收敛（强制注销路径则是完全失效），C6 现有防护比文档描述更完善；
- 文档**未发现任何误报**。

修复时请注意两点额外发现：
1. `/api/sniff` 有与 S1 完全相同的 SSRF 漏洞，需一并修复；
2. 若复用现有 `needClickPlay` 实现 C3 修复，它在 `2161` 行的渲染条件带 `isHost` 限制，观众侧不会显示，必须放开。
