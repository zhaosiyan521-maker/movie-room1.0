@echo off
chcp 65001 >nul
title 停止 Movie Room
echo 正在停止 Movie Room 服务（端口 3001 与 5173）...

REM 通过端口找到 PID 并结束进程（只杀本应用占用这两个端口的进程）
for %%P in (3001 5173) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr :%%P ^| findstr LISTENING') do (
        taskkill /PID %%a /F >nul 2>&1
        echo   已停止占用端口 %%P 的进程 (PID %%a)
    )
)

echo 已完成。可重新双击「一键启动.bat」再次启动。
pause
