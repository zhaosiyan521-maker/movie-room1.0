# GitHub 推送通道说明（本机专用）

## 背景

本机所在网络有一个名为 `APNetwork` 的虚拟网卡（fake-IP 代理，IP `198.18.0.2`），
它会拦截并重置：

| 通道 | 结果 |
|---|---|
| `github.com:22`（SSH） | ❌ 被 `198.18.0.22` 重置（`kex_exchange_identification: Connection reset`） |
| `github.com:443`（HTTPS） | ⚠️ 时通时断，TCP 约 7/10 成功，**传输阶段常被重置** |
| **`ssh.github.com:443`（SSH over 443）** | ✅ **稳定可用**（实测认证成功并完成推送） |

因此本仓库的 `origin` 已指向 SSH over 443。

## 当前配置

```bash
# 远端
origin    ssh://git@ssh.github.com:443/zhaosiyan521-maker/movie-room1.0.git
GH-mirror https://ghfast.top/https://github.com/...   # 仅备用（该镜像不支持 push）

# 让 git 走专用密钥 + 443 端口
git config core.sshCommand "ssh -i <仓库根>/dsh-github-key \
  -o IdentitiesOnly=yes \
  -o UserKnownHostsFile=<仓库根>/dsh-github-known-hosts \
  -o StrictHostKeyChecking=accept-new -p 443"
```

## 相关文件（均已加入 .gitignore，绝不入库）

| 文件 | 用途 |
|---|---|
| `dsh-github-key` | GitHub 推送专用私钥（ed25519） |
| `dsh-github-known-hosts` | GitHub 主机密钥（含 `[ssh.github.com]:443` 条目） |
| `dsh-sync-key` / `dsh-known-hosts` | 服务器部署同步专用密钥 |

## 日常使用

```powershell
git push            # 直接用，无需额外参数
git ls-remote --heads origin
```

## 重要提醒

**`core.sshCommand` 里的路径必须用正斜杠 `/`。** 用反斜杠会被 SSH 吞掉，
报成 `Identity file D:WorkBuddy2026-... not accessible` —— 这个坑已经踩过一次。

## 若密钥失效或需要收回访问权

公钥已添加到 GitHub 账号的 `dsh-github-push`。
在 GitHub → Settings → SSH and GPG keys 里删除该 key，即可立即收回访问权。

重新签发流程：

```powershell
cd <仓库根>
ssh-keygen -t ed25519 -f dsh-github-key -N '""' -C 'dsh-github-push'
ssh-keygen -y -f dsh-github-key     # 把输出添加到 GitHub
# 刷新主机密钥（脚本可参照 git log 中本文件的引入提交）
```
