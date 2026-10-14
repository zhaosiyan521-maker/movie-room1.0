# 服务器同步助手（Windows / PowerShell）

把本地提交同步到阿里云服务器，并按需重构建、重启、验证。
密钥与 known_hosts 位于仓库根目录（`dsh-sync-key` / `dsh-known-hosts`），**不要提交到 git**。

## 前置

- 安全组入方向需放行 22，来源限制为你当前公网 IP（`/32`）
- 服务器上已安装我提供的公钥（`~/.ssh/authorized_keys` 中含 `dsh-sync-temporary`）

## 用法

```powershell
# 1) 只做状态检查（不改动任何东西）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-server.ps1 -Action status

# 2) 完整同步：备份 -> 合并/快进 -> 构建 -> 重启 -> 验证
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-server.ps1 -Action sync

# 3) 只重建并重启（源码已是最新，仅需重新编译）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-server.ps1 -Action rebuild
```

> 本机只有 Windows PowerShell 5.1（没有 `pwsh`），所以用 `powershell` 调用。
> 也可指定其它服务器/分支：`-Server root@1.2.3.4 -Branch main`

## 说明

- 服务器检出的是 **main** 分支，本地改动通常推在特性分支上，
  因此同步动作是把 `origin/<分支>` **快进合并**进 main（`git merge --ff-only`）。
- 每次 sync 都会在服务器上备份数据库：
  - `/root/backup-<时间戳>.tar.gz`（含 `dev.db` 与 `uploads/`）
  - `/root/dev.db.pre-restart-<时间戳>`（数据库裸拷贝，回滚更快）
- `.tmp-chrome/`、`.tmp-src/` 等本地临时目录已在 `.gitignore` 中忽略。
- 服务器**未配置** `TRUST_PROXY`（当前直连 3001、无反向代理），这是正确配置。
  若日后加 Nginx + HTTPS，必须同时设置 `TRUST_PROXY="1"`，否则登录限流、
  IP 封禁与开房配额会全部失效（见 `部署方案-阿里云.md` 第 10.1 节）。
