@echo off
setlocal
title NexusAI Bridge

rem ===========================================================================
rem  NexusAI Bridge - Windows Launcher
rem
rem  Startet die Bridge. URL und Token werden bei JEDEM Start neu erzeugt und
rem  in der ---BRIDGE--- Box ausgegeben. Es gibt keinen festen Token.
rem
rem  Beispiele:
rem     start-bridge.bat
rem     start-bridge.bat --port 8787
rem     start-bridge.bat --log-level debug --open
rem ===========================================================================

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [FEHLER] Node.js wurde nicht gefunden.
    echo          Bitte Node.js 18 oder neuer installieren: https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist "src\index.js" (
    echo.
    echo [FEHLER] src\index.js nicht gefunden.
    echo          Bitte start-bridge.bat aus dem Repo-Stammverzeichnis starten.
    echo.
    pause
    exit /b 1
)

rem PowerShell-Launcher bevorzugen (schoenere Ausgabe + Token-Extraktion).
where powershell >nul 2>&1
if errorlevel 1 goto :plain_node

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start-bridge.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
goto :done

:plain_node
echo.
echo [INFO] PowerShell nicht verfuegbar - starte Node direkt.
echo.
node "src\index.js" %*
set "EXITCODE=%ERRORLEVEL%"

:done
echo.
echo NexusAI Bridge beendet (Exit-Code %EXITCODE%).
if not "%NEXUSAI_NO_PAUSE%"=="1" pause
exit /b %EXITCODE%
