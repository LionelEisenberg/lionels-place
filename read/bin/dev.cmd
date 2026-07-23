@echo off
REM Tiny wrapper so `bin\dev` works from any shell (cmd, PowerShell, Git Bash).
REM Calls dev.ps1 with execution policy bypassed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
