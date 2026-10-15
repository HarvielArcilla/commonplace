@echo off
rem Starts Commonplace (Windows). Used by the Desktop shortcut.
cd /d "%~dp0.."
call npm.cmd run dev
if errorlevel 1 pause
