@echo off
REM ==========================================================================
REM  NEONDRIFT GP - one-click setup for Windows
REM  Installs dependencies, copies the MediaPipe runtime, downloads the hand
REM  model for offline play, runs the test suite, and builds the app.
REM ==========================================================================
setlocal
cd /d "%~dp0\.."

echo.
echo  =========================================
echo   NEONDRIFT GP  -  Setup
echo  =========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node 20+ from https://nodejs.org
  exit /b 1
)

echo [1/4] Installing dependencies...
call npm install --no-fund --no-audit || goto :fail

echo.
echo [2/4] Downloading hand-tracking model for offline play...
call npm run setup

echo.
echo [3/4] Running tests...
call npm test || goto :fail

echo.
echo [4/4] Building production bundle...
call npm run build || goto :fail

echo.
echo  =========================================
echo   Setup complete!
echo.
echo   Play in the browser:   npm run dev
echo   Play on the desktop:   npm run desktop
echo  =========================================
exit /b 0

:fail
echo.
echo [ERROR] Setup failed. See the output above.
exit /b 1
