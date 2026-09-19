param(
    [switch]$CpuOnly,
    [string]$PythonVersion = "3.11"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root ".venv_transcribe"

function Resolve-PythonLauncher {
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) { return @($py.Source, "-$PythonVersion") }
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) { return @($python.Source) }
    throw "Python не найден. Установите Python $PythonVersion x64 и повторите запуск."
}

$launcher = Resolve-PythonLauncher
if (-not (Test-Path -LiteralPath $venv)) {
    Write-Host "Создание виртуального окружения $venv"
    if ($launcher.Count -eq 2) {
        & $launcher[0] $launcher[1] -m venv $venv
    } else {
        & $launcher[0] -m venv $venv
    }
}

$python = Join-Path $venv "Scripts\python.exe"
& $python -m pip install --upgrade pip
$requirements = if ($CpuOnly) { "requirements.txt" } else { "requirements-cuda.txt" }
& $python -m pip install -r (Join-Path $root $requirements)

$nodeModulesTarget = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
$nodeModulesLink = Join-Path $root "workbook_build\node_modules"
if (Test-Path -LiteralPath $nodeModulesTarget) {
    if (-not (Test-Path -LiteralPath $nodeModulesLink)) {
        New-Item -ItemType Junction -Path $nodeModulesLink -Target $nodeModulesTarget | Out-Null
        Write-Host "Создана ссылка на @oai/artifact-tool."
    }
} else {
    Write-Warning "Среда Codex с @oai/artifact-tool пока не найдена. Откройте проект в Codex Desktop и повторите setup_windows.ps1."
}

if (-not (Get-Command ollama.exe -ErrorAction SilentlyContinue)) {
    Write-Warning "Ollama не найден. Установите Ollama, затем выполните: ollama pull qwen2.5:7b"
} else {
    Write-Host "Ollama найден. Для основной модели выполните: ollama pull qwen2.5:7b"
}

Write-Host "Настройка завершена."

