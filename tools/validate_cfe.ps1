<#
.SYNOPSIS
    Сборка и проверка расширения MCP_Сервер.cfe локальной платформой 1С.

.DESCRIPTION
    Обязательный шаг ПЕРЕД передачей .cfe на загрузку в рабочую базу.

    Порядок:
      1. Сборка .cfe из XML-исходников (v8unpack)
      2. Создание временной файловой ИБ
      3. Загрузка расширения в ИБ (/LoadCfg -Extension)
      4. Полная проверка конфигурации (/CheckConfig)

    ВАЖНО: /CheckModules НЕДОСТАТОЧНО. Он проверяет только синтаксис BSL и
    пропускает ошибки в тексте запросов и необъявленные переменные —
    именно такие дефекты приводят к ошибке «Ошибка инициализации модуля»
    уже в рабочей базе. Полноценную проверку даёт только /CheckConfig
    с ключами -IncorrectReferences и режимами клиента.

    Код возврата 0 — расширение можно грузить в рабочую базу.
    Код возврата 101 (или иной) — в логе перечислены дефекты.

.PARAMETER SourceDir
    Каталог XML-исходников расширения. Если не указан — сборка пропускается
    и проверяется уже готовый файл из -CfePath.

.PARAMETER CfePath
    Путь к .cfe. По умолчанию build\MCP_Сервер.cfe в корне репозитория.

.PARAMETER PlatformBin
    Каталог bin платформы 1С.

.EXAMPLE
    # Собрать из исходников и проверить
    powershell -File tools\validate_cfe.ps1 -SourceDir C:\path\to\src

.EXAMPLE
    # Проверить уже собранный файл
    powershell -File tools\validate_cfe.ps1
#>
param(
    [string]$SourceDir = "",
    [string]$CfePath = "",
    [string]$PlatformBin = "C:\Users\SaraninRG\AppData\Local\Programs\1cv8_x64\8.3.27.1859\bin",
    [string]$ExtensionName = "MCP_Сервер",
    [string]$CompatVersion = "80327"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $CfePath) { $CfePath = Join-Path $repoRoot "build\MCP_Сервер.cfe" }

$exe = Join-Path $PlatformBin "1cv8.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "Не найден 1cv8.exe: $exe" }

$work = Join-Path $env:TEMP "cfe_validate_$(Get-Date -Format yyyyMMdd_HHmmss)"
New-Item -ItemType Directory -Path $work -Force | Out-Null
$ib  = Join-Path $work "ib"
$log = Join-Path $work "checkconfig.log"

function Step($n, $text) { Write-Host "[$n] $text" -ForegroundColor Cyan }

try {
    # ── 1. Сборка ────────────────────────────────────────────────────────────
    if ($SourceDir) {
        Step 1 "Сборка .cfe из $SourceDir"
        Remove-Item -LiteralPath $CfePath -Force -ErrorAction SilentlyContinue
        # v8unpack пишет прогресс в stderr — перенаправляем, иначе PowerShell
        # трактует это как ошибку выполнения
        $buildLog = Join-Path $work "build.log"
        $build = Start-Process -FilePath "python" -Wait -PassThru -NoNewWindow `
            -ArgumentList @("-m", "v8unpack", "-B", "`"$SourceDir`"", "`"$CfePath`"", "--version", $CompatVersion) `
            -RedirectStandardError $buildLog -RedirectStandardOutput (Join-Path $work "build.out")
        if ($build.ExitCode -ne 0) { throw "v8unpack завершился с кодом $($build.ExitCode). Лог: $buildLog" }
        if (-not (Test-Path -LiteralPath $CfePath)) { throw "Сборка не создала файл: $CfePath" }
    } else {
        Step 1 "Сборка пропущена, проверяется готовый файл"
    }
    $size = (Get-Item -LiteralPath $CfePath).Length
    Write-Host "    $CfePath ($size байт)"

    # ── 2. Временная ИБ ──────────────────────────────────────────────────────
    Step 2 "Создание временной ИБ"
    New-Item -ItemType Directory -Path $ib -Force | Out-Null
    & $exe CREATEINFOBASE "File=`"$ib`";" /DisableStartupDialogs | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $ib "1Cv8.1CD"))) { throw "Не удалось создать ИБ" }

    # ── 3. Загрузка расширения ───────────────────────────────────────────────
    Step 3 "Загрузка расширения в ИБ"
    $load = Start-Process -FilePath $exe -Wait -PassThru -NoNewWindow -ArgumentList @(
        "DESIGNER", "/F", "`"$ib`"", "/DisableStartupDialogs",
        "/LoadCfg", "`"$CfePath`"", "-Extension", $ExtensionName
    )
    if ($load.ExitCode -ne 0) { throw "LoadCfg завершился с кодом $($load.ExitCode)" }

    # ── 4. Полная проверка ───────────────────────────────────────────────────
    Step 4 "Проверка конфигурации (/CheckConfig)"
    $check = Start-Process -FilePath $exe -Wait -PassThru -NoNewWindow -ArgumentList @(
        "DESIGNER", "/F", "`"$ib`"", "/DisableStartupDialogs",
        "/CheckConfig",
        "-IncorrectReferences",
        "-ThinClient", "-Server", "-ExternalConnection",
        "-ThickClientManagedApplication",
        "-Extension", $ExtensionName,
        "/Out", "`"$log`""
    )

    Write-Host ""
    if (Test-Path -LiteralPath $log) {
        Get-Content -LiteralPath $log -Encoding Default | ForEach-Object { Write-Host $_ }
    }
    Write-Host ""

    if ($check.ExitCode -eq 0) {
        Write-Host "РЕЗУЛЬТАТ: OK — расширение можно грузить в рабочую базу" -ForegroundColor Green
        exit 0
    }
    Write-Host "РЕЗУЛЬТАТ: ОШИБКИ (exit=$($check.ExitCode)) — грузить в базу НЕЛЬЗЯ" -ForegroundColor Red
    exit $check.ExitCode
}
finally {
    Remove-Item -LiteralPath $ib -Recurse -Force -ErrorAction SilentlyContinue
}
