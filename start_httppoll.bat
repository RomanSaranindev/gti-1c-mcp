@echo off
chcp 65001 > nul
echo ============================================================
echo   gti-1c-mcp: Python-прокси в режиме httppoll
echo   1С-агент подключается к: http://IP_ЭТОГО_ПК:9090
echo ============================================================

cd /d "%~dp0"

:: Проверяем Python
python --version > nul 2>&1
if errorlevel 1 (
    echo ОШИБКА: Python не найден. Установите Python 3.11+ с https://python.org
    pause
    exit /b 1
)

:: Создаём venv если нет
if not exist "py_proxy\venv\Scripts\python.exe" (
    echo.
    echo [УСТАНОВКА] Создаю виртуальное окружение...
    python -m venv py_proxy\venv
    echo [УСТАНОВКА] Устанавливаю зависимости...
    py_proxy\venv\Scripts\pip install -r py_proxy\requirements.txt --quiet
    if errorlevel 1 (
        echo Повтор без проверки SSL...
        py_proxy\venv\Scripts\pip install -r py_proxy\requirements.txt ^
            --trusted-host pypi.org --trusted-host files.pythonhosted.org --quiet
    )
    echo [УСТАНОВКА] Готово.
)

:: Показываем IP этой машины чтобы было понятно что вводить в 1С
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set IP=%%a
    set IP=!IP: =!
    echo [IP этой машины]: !IP!
)
echo Если IP не определился - запустите ipconfig в cmd и найдите строку IPv4 Address
echo.

echo [INFO] Запускаю прокси в режиме httppoll (листенер: 0.0.0.0:9090)...
echo.
echo ============================================================
echo  ЧТО СДЕЛАТЬ В 1С:
echo    1. Зайдите в базу под администратором
echo    2. Откройте обработку расширения:
echo       НСИ -^> Управление MCP-сервером
echo       (или найдите через Все функции -^> Обработки)
echo    3. Вкладка "MCP без веб-сервера (тест)"
echo    4. Выберите режим: httppoll
echo    5. Укажите адрес: http://IP_ЭТОГО_ПК:9090
echo    6. Нажмите "Старт"
echo ============================================================
echo.
echo  Для остановки нажмите Ctrl+C
echo.

:: Запуск: -u отключает буферизацию stdout/stderr
py_proxy\venv\Scripts\python -u -m py_proxy stdio

pause
