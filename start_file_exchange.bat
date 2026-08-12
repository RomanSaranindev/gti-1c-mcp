@echo off
chcp 65001 > nul
echo ============================================================
echo   gti-1c-mcp: режим FILE EXCHANGE (обмен через папку)
echo ============================================================
echo.
echo   Локальная папка: C:\Users\SaraninRG\Desktop\MCP_Obmen
echo   Папка на сервере 1С: D:\Саранин Р.Г\MCP_Obmen
echo   Таймаут ожидания ответа: 300 секунд (5 минут)
echo.
echo   ПОРЯДОК РАБОТЫ ПРИ КАЖДОМ ЗАПРОСЕ:
echo   1. Агент отправляет запрос - файл появится в папке IN
echo   2. Вы копируете файл из:
echo      C:\Users\SaraninRG\Desktop\MCP_Obmen\in\
echo      в:
echo      D:\Саранин Р.Г\MCP_Obmen\in\  (на сервер 1С)
echo   3. 1С обрабатывает и кладёт ответ в:
echo      D:\Саранин Р.Г\MCP_Obmen\out\
echo   4. Вы копируете ответный файл из:
echo      D:\Саранин Р.Г\MCP_Obmen\out\
echo      в:
echo      C:\Users\SaraninRG\Desktop\MCP_Obmen\out\
echo   5. Прокси читает ответ и передаёт агенту
echo ============================================================
echo.

cd /d "%~dp0"

:: Создаём папки если нет
if not exist "C:\Users\SaraninRG\Desktop\MCP_Obmen\in"  mkdir "C:\Users\SaraninRG\Desktop\MCP_Obmen\in"
if not exist "C:\Users\SaraninRG\Desktop\MCP_Obmen\out" mkdir "C:\Users\SaraninRG\Desktop\MCP_Obmen\out"

:: Создаём venv если нет
if not exist "py_proxy\venv\Scripts\python.exe" (
    echo [УСТАНОВКА] Создаю виртуальное окружение...
    python -m venv py_proxy\venv
    echo [УСТАНОВКА] Устанавливаю зависимости...
    py_proxy\venv\Scripts\pip install -r py_proxy\requirements.txt --quiet
    if errorlevel 1 (
        py_proxy\venv\Scripts\pip install -r py_proxy\requirements.txt ^
            --trusted-host pypi.org --trusted-host files.pythonhosted.org --quiet
    )
    echo [УСТАНОВКА] Готово.
    echo.
)

echo [СТАРТ] Запускаю прокси в режиме file-exchange...
echo [INFO]  Слежу за папкой: C:\Users\SaraninRG\Desktop\MCP_Obmen
echo [INFO]  Для остановки нажмите Ctrl+C
echo.

py_proxy\venv\Scripts\python -u -m py_proxy stdio

pause
