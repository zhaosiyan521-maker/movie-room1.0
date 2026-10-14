<#
  服务器同步助手 —— 把本地提交同步到阿里云 ECS 上的 Movie Room。

  前置：根目录存在 dsh-sync-key / dsh-known-hosts（这两个文件不要提交到 git）。
  用法：
    pwsh -File scripts/sync-server.ps1 -Action status    # 只读检查
    pwsh -File scripts/sync-server.ps1 -Action sync      # 备份+合并+构建+重启+验证
    pwsh -File scripts/sync-server.ps1 -Action rebuild   # 只重建并重启

  注意：远端命令通过 base64 + cmd 重定向传入，避免 PowerShell 破坏引号与非 ASCII 字符。
#>
param(
  [ValidateSet('status', 'sync', 'rebuild')]
  [string]$Action = 'status',
  [string]$Server = 'root@121.43.63.229',
  [string]$Branch = 'feat/admin-broadcast-and-fixes',
  [string]$AppDir = '/opt/movie-room'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$key  = Join-Path $root 'dsh-sync-key'
$kh   = Join-Path $root 'dsh-known-hosts'
if (-not (Test-Path $key)) { throw "找不到私钥: $key" }
if (-not (Test-Path $kh))  { New-Item -ItemType File -Path $kh -Force | Out-Null }

$sshOpts = "-i `"$key`" -o IdentitiesOnly=yes -o `"UserKnownHostsFile=$kh`" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o BatchMode=yes"

function Invoke-RemoteScript {
  param([string]$ScriptText, [string]$Label = 'remote')
  $tmp = Join-Path $env:TEMP ("dsh-$Label-" + [guid]::NewGuid().ToString('N') + ".sh")
  # 统一 LF，避免远端 bash 报 $'\r'
  [IO.File]::WriteAllText($tmp, ($ScriptText -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false))
  $b64 = Join-Path $env:TEMP ("dsh-$Label-" + [guid]::NewGuid().ToString('N') + ".b64")
  [IO.File]::WriteAllText($b64, [Convert]::ToBase64String([IO.File]::ReadAllBytes($tmp)), [Text.Encoding]::ASCII)
  $out = Join-Path $env:TEMP ("dsh-$Label-out.txt")

  # 1) 传脚本：base64 经 cmd 重定向到 ssh stdin，远端 base64 -d 落盘
  $send = "ssh $sshOpts $Server `"base64 -d > /tmp/dsh-run.sh`""
  cmd /c "$send < `"$b64`" > `"$out`" 2>&1" | Out-Null
  # 2) 执行
  $run = "ssh $sshOpts $Server `"bash /tmp/dsh-run.sh; rm -f /tmp/dsh-run.sh`""
  cmd /c "$run > `"$out`" 2>&1" | Out-Null
  Remove-Item $tmp, $b64 -Force -ErrorAction SilentlyContinue
  $text = Get-Content $out -Encoding UTF8 -ErrorAction SilentlyContinue
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  return $text
}

$statusScript = @"
cd $AppDir || { echo "FATAL: cd failed"; exit 1; }
echo "HEAD=`$(git rev-parse --short HEAD)"
echo "BRANCH=`$(git branch --show-current)"
echo "--- 与远端差异 ---"
timeout 120 git fetch origin 2>&1 | tail -2
echo "local =`$(git rev-parse --short HEAD)"
echo "origin/main =`$(git rev-parse --short origin/main)"
echo "origin/$Branch =`$(git rev-parse --short origin/$Branch)"
echo "--- 工作区 ---"
git status --porcelain | head -5
echo "--- pm2 ---"
pm2 list 2>/dev/null | grep movie-room
echo "--- health ---"
curl -s -m 8 http://127.0.0.1:3001/api/health; echo ""
echo "--- 备份文件 ---"
ls -1 /root/backup-*.tar.gz 2>/dev/null | tail -3
echo "STATUS DONE"
"@

$syncScript = @"
cd $AppDir || { echo "FATAL: cd failed"; exit 1; }
TS=`$(date +%Y%m%d-%H%M%S)
echo "=== 1) 备份 ==="
tar -czf /root/backup-`$TS.tar.gz server/prisma/dev.db server/uploads 2>/dev/null && echo "backup -> /root/backup-`$TS.tar.gz"
cp -a server/prisma/dev.db /root/dev.db.pre-sync-`$TS && echo "db -> /root/dev.db.pre-sync-`$TS"
echo "=== 2) 快进合并 ==="
timeout 180 git fetch origin 2>&1 | tail -2
git merge --ff-only origin/$Branch || { echo "MERGE_FAILED: 需要人工处理，未做破坏性操作"; exit 2; }
echo "HEAD=`$(git rev-parse --short HEAD)"
echo "=== 3) 构建 ==="
npm run build:client 2>&1 | tail -2
npm run build:server 2>&1 | tail -2
[ -f server/dist/services/roomImages.js ] || { echo "BUILD_CHECK_FAILED"; exit 3; }
echo "=== 4) 重启与验证 ==="
pm2 restart movie-room 2>&1 | tail -2
sleep 8
curl -s -m 8 http://127.0.0.1:3001/api/health; echo ""
pm2 list 2>/dev/null | grep movie-room
echo "DONE"
"@

$rebuildScript = @"
cd $AppDir || { echo "FATAL: cd failed"; exit 1; }
TS=`$(date +%Y%m%d-%H%M%S)
cp -a server/prisma/dev.db /root/dev.db.pre-restart-`$TS && echo "db -> /root/dev.db.pre-restart-`$TS"
npm run build:client 2>&1 | tail -2
npm run build:server 2>&1 | tail -2
pm2 restart movie-room 2>&1 | tail -2
sleep 8
curl -s -m 8 http://127.0.0.1:3001/api/health; echo ""
pm2 list 2>/dev/null | grep movie-room
echo "DONE"
"@

switch ($Action) {
  'status'  { Invoke-RemoteScript -ScriptText $statusScript  -Label 'status' }
  'sync'    { Invoke-RemoteScript -ScriptText $syncScript    -Label 'sync' }
  'rebuild' { Invoke-RemoteScript -ScriptText $rebuildScript -Label 'rebuild' }
}
