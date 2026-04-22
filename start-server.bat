@echo off
title RoboArm IPN — Servidor arduino-cli

REM Punto de entrada rápido para el servidor companion basado en Node.js.
echo.
echo  ========================================
echo   RoboArm IPN - Servidor arduino-cli
echo  ========================================
echo.

REM Verifica primero Node.js porque server.js depende de este runtime.
echo  Verificando Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js no encontrado.
    echo  Descarga en: https://nodejs.org
    pause
    exit /b 1
)
echo  Node.js OK

REM arduino-cli es opcional para arrancar, pero necesario para compilar/subir.
echo  Verificando arduino-cli...
arduino-cli version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  AVISO: arduino-cli no encontrado.
    echo  Instala con:  winget install ArduinoSA.CLI
    echo  Luego:        arduino-cli core install arduino:avr
    echo.
    echo  El servidor iniciara pero la subida no funcionara
    echo  hasta que instales arduino-cli.
    echo.
)

echo.
REM El servidor escucha localmente para que la interfaz web pueda invocarlo.
echo  Iniciando servidor en http://localhost:8080
echo  Presiona Ctrl+C para detener.
echo.
node "%~dp0server.js"

REM Mantener la ventana abierta si el proceso terminó o falló.
pause
