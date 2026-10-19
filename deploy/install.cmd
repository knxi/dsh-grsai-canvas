@echo off
rem Double-click friendly wrapper. Keep this file ASCII-only and CRLF.
setlocal
set "HERE=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %*
echo.
pause
