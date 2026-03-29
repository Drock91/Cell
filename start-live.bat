@echo off
:restart
echo [CELL] Starting LIVE bot... %date% %time%
node src/index.js --live --dashboard
echo [CELL] Bot exited with code %errorlevel% — restarting in 15s... %date% %time%
timeout /t 15 /nobreak > nul
goto restart
