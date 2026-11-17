@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   AI Draw Guess - offline server
echo ============================================
if not exist "node_modules" (
  echo [!] node_modules not found. Run: npm install
  pause
  exit /b 1
)
node scripts\show-urls.js
node server\index.js
if errorlevel 1 (
  echo.
  echo [!] Server stopped with an error. See README.md
  pause
)
