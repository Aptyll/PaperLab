@echo off
rem Double-click this once to put a "Paper Lab" icon on your desktop.
rem It adds nothing to Windows startup.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-desktop-shortcut.ps1"
echo You can close this window.
pause
