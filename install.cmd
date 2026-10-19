@echo off
rem One-click install. Just double-click this file.
rem Keep this file ASCII-only and CRLF - cmd.exe mis-parses UTF-8/LF.
setlocal
set "HERE=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%HERE%deploy\install.ps1" -Source "%HERE%." %*
echo.
pause
