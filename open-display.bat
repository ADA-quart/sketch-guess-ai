@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Opening /display fullscreen on the HDMI (secondary) monitor...
echo Make sure the Node server is already running (start.bat).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-display.ps1" -Url "http://127.0.0.1:3000/display"
if errorlevel 1 (
  echo.
  echo Failed to open the display window. See the message above.
  pause
)
