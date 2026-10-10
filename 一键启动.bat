@echo off
chcp 65001 >nul
title Movie Room 一键启动（网页版）
cd /d %~dp0

echo ========================================
echo        🎬 Movie Room 一键启动（网页版）
echo ========================================
echo.

REM 检查 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 18+ ：https://nodejs.org
    pause
    exit /b 1
)

REM 1) 首次运行：安装依赖
if not exist "node_modules" (
    echo [1/6] 首次运行，正在安装依赖（可能需要几分钟）...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
) else (
    echo [1/6] 依赖已安装，跳过
)

REM 2) 生成 server/.env（关键！没有 .env 后端连不上数据库，注册/登录会全部失败）
if not exist "server\.env" (
    echo [2/6] 未检测到 server/.env，正在生成配置与随机 JWT 密钥...
    set "JWTKEY="
    for /f "usebackq delims=" %%k in (`powershell -NoProfile -Command "$b=New-Object byte[] 32; $r=[System.Security.Cryptography.RandomNumberGenerator]::Create(); $r.GetBytes($b); [System.BitConverter]::ToString($b).Replace('-','').ToLower()"`) do set "JWTKEY=%%k"

    if not defined JWTKEY (
        echo [错误] 随机生成 JWT 密钥失败。
        echo        请手动创建 server\.env，并将 JWT_SECRET 设置为 32 位以上随机字符串。
        pause
        exit /b 1
    )

    (
        echo # 由一键启动脚本自动生成，请勿提交到代码仓库
        echo DATABASE_URL="file:./dev.db"
        echo JWT_SECRET="%JWTKEY%"
        echo PORT=3001
        echo HOST="127.0.0.1"
        echo CLIENT_URL="http://localhost:5173,http://localhost:3001,http://127.0.0.1:3001"
        echo SMTP_HOST=""
        echo SMTP_PORT="587"
        echo SMTP_SECURE="false"
        echo SMTP_USER=""
        echo SMTP_PASS=""
        echo SMTP_FROM=""
    ) > "server\.env"

    set "JWTKEY="
    echo        已生成 server\.env（含随机 JWT 密钥）
) else (
    echo [2/6] server/.env 已存在，跳过
)

REM 3) 初始化 / 同步数据库
echo [3/6] 正在初始化数据库（prisma db push）...
cd server
call npx prisma db push
if %errorlevel% neq 0 (
    echo [警告] 数据库初始化失败，请检查上方错误信息
) else (
    echo        数据库已就绪
)
call npx prisma generate >nul 2>nul
cd ..

REM 4) 构建前端（网页版：把 React 前端打包成静态文件，交由后端托管）
echo [4/6] 正在构建前端（网页版静态资源）...
cd client
call npx vite build
if %errorlevel% neq 0 (
    echo [错误] 前端构建失败，请检查上方错误信息
    pause
    exit /b 1
)
echo        前端已构建 ✅
cd ..

REM 5) 启动后端（后端同时托管前端页面，等待端口真正就绪）
echo [5/6] 正在启动服务 http://localhost:3001 ...
start "MovieRoom-Server" /min cmd /c "cd /d %~dp0server && npx ts-node src/index.ts >> ..\server.log 2>&1"

set BACKEND_OK=0
for /l %%i in (1,1,40) do (
    powershell -NoProfile -Command "try { if ((Invoke-WebRequest 'http://localhost:3001/api/health' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { exit 0 } } catch { exit 1 }"
    if not errorlevel 1 (
        set BACKEND_OK=1
        goto :backend_done
    )
    timeout /t 1 /nobreak >nul
)
:backend_done
if %BACKEND_OK%==0 (
    echo [警告] 后端 40 秒内未就绪，请查看 server.log 排查（常见原因：3001 端口被占用）。
) else (
    echo        服务已就绪 ✅
)

echo.
echo ========================================
echo  ✅ 启动完成！（网页版，无需 Electron）
echo.
echo  🎬 主页面：     http://localhost:3001
echo  🛡️  管理员页面： http://localhost:3001/admin
echo.
echo  ℹ️  管理员账号不再通过注册自动获得。如需管理员，请在此目录运行：
echo       cd server ^&^& npx ts-node scripts/reset-admin.ts
echo     （该脚本会清空所有数据，并按环境变量 ADMIN_PASSWORD 创建管理员）
echo.
echo  ⚠️  服务默认仅监听本机 127.0.0.1。
echo     如需局域网内其他设备加入观影，请修改 server\.env：
echo       HOST="0.0.0.0"  并把 CLIENT_URL 设为对应前端地址（逗号分隔多个）。
echo.
echo  关闭本窗口不会停止服务；
echo  要停止服务请运行「停止MovieRoom.bat」
echo ========================================
echo.

start http://localhost:3001

pause
