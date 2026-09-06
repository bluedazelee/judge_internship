@echo off
setlocal

rem Judge document viewer - double-click launcher.
rem
rem This file is deliberately ASCII-only. cmd.exe parses batch files using the
rem console OEM codepage, so non-ASCII bytes here corrupt the parsing itself
rem (broken rem lines get executed as commands, if-blocks fall apart).
rem All Chinese-language output belongs in serve.js and in the web page, where
rem UTF-8 is handled reliably.
rem
rem Why a server is needed at all: the browser CORS policy blocks fetch() under
rem the file:// protocol, so double-clicking index.html cannot read Judge.md.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

node "%~dp0serve.js"

rem Keep the window open if the server exited with an error, so the message
rem printed above stays readable instead of the window vanishing.
if errorlevel 1 (
    echo.
    echo   Server stopped with an error. Please read the message above.
    pause
)
goto :eof

:no_node
echo.
echo   [Cannot start] Node.js was not found.
echo.
echo   This viewer needs Node.js to run the local web server.
echo   Install it from https://nodejs.org and try again.
echo.
echo   Press any key to close this window.
pause >nul
exit /b 1
