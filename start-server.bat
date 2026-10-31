@echo off
chcp 65001 >nul
cd /d %~dp0
echo ================================================
echo   MagicHub 脚本化服务器（无需打包 exe，体积更小）
echo   数据目录: %~dp0data        （MAGICHUB_DATA_DIR 可覆盖）
echo   插件市场: %~dp0plugins
echo   前端发布: %~dp0release\web （node tools/pack.mjs server 生成）
echo ================================================
echo 正在启动服务器（端口 3000，PORT 环境变量可覆盖）...
node apps/server/server.js
echo.
echo 服务器已退出。
pause
