@echo off
:restart
echo [CELL] Starting paper bot... %date% %time%
node src/index.js --paper --dashboard
echo [CELL] Bot exited with code %errorlevel% — restarting in 10s... %date% %time%
timeout /t 10 /nobreak > nul
goto restart
