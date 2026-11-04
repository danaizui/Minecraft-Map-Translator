@echo off
cd /d "%~dp0"
title MC 地图翻译器

if exist "%~dp0runtime\node.exe" (
  set "NODE_EXE=%~dp0runtime\node.exe"
) else (
  set "NODE_EXE=node.exe"
)

echo 正在启动 MC 地图翻译器...
echo 如果窗口没有自动打开界面，请手动访问：http://127.0.0.1:17321/
echo.
"%NODE_EXE%" "%~dp0app\server.js"

echo.
echo 程序已退出。按任意键关闭此窗口。
pause >nul
