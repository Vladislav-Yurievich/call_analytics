param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,
    [string]$PrimaryModel = "qwen2.5:7b",
    [string]$FallbackModel = "qwen3:14b",
    [switch]$CpuOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root ".venv_transcribe\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "Виртуальное окружение не найдено. Сначала запустите scripts\setup_windows.ps1."
}

$resolvedConfig = (Resolve-Path -LiteralPath (Join-Path $root $ConfigPath)).Path
$config = Get-Content -LiteralPath $resolvedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
$nodeCandidate = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$node = if (Test-Path -LiteralPath $nodeCandidate) {
    $nodeCandidate
} else {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $command) { throw "Node.js не найден. Откройте проект в Codex Desktop или установите Node.js." }
    $command.Source
}

if (-not (Test-Path -LiteralPath (Join-Path $root "workbook_build\node_modules\@oai\artifact-tool"))) {
    throw "@oai/artifact-tool не найден. Повторно запустите scripts\setup_windows.ps1 из Codex Desktop."
}

$checker = Join-Path $PSScriptRoot "check_four_department_results.py"
$statusPath = Join-Path $root "pipeline_status.txt"
$pidPath = Join-Path $root "pipeline_pid.txt"
$mutexName = "Local\CallsAnalytics_" + [IO.Path]::GetFileNameWithoutExtension($resolvedConfig).Replace("-", "_")
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$locked = $false

function Set-Status([string]$Text) {
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Set-Content -LiteralPath $statusPath -Value "$stamp`t$Text" -Encoding UTF8
    Write-Host "$stamp $Text"
}

function Test-Stage([object]$Department, [string]$Stage) {
    $result = & $python $checker --config $resolvedConfig --department $Department.key --stage $Stage --rebuild-manifests
    $complete = $LASTEXITCODE -eq 0
    $parsed = $result | ConvertFrom-Json
    foreach ($item in $parsed) {
        Write-Host "$($Department.key) ${Stage}: $($item.valid)/$($item.expected), extra JSON: $($item.extraJson.Count)"
    }
    return $complete
}

try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw "Для этой конфигурации уже запущен другой процесс." }
    Set-Location -LiteralPath $root
    Set-Content -LiteralPath $pidPath -Value $PID -Encoding ASCII

    Set-Status "Проверка исходных файлов и сопоставления менеджеров"
    & $node "workbook_build\preflight_four_departments.mjs" $resolvedConfig
    if ($LASTEXITCODE -ne 0) { throw "Предварительная проверка не пройдена." }

    foreach ($department in $config.departments) {
        if (Test-Stage $department "transcripts") { continue }
        Set-Status "Транскрибация: $($department.name)"
        $device = if ($CpuOnly) { "cpu" } else { "cuda" }
        $compute = if ($CpuOnly) { "int8" } else { "float16" }
        & $python "scripts\transcribe_calls.py" --input-dir $department.inputDir --output-dir $department.transcriptsDir `
            --model large-v3 --device $device --compute-type $compute --beam-size 5 --best-of 5 --language-detection-segments 3
        if ($LASTEXITCODE -ne 0 -or -not (Test-Stage $department "transcripts")) {
            throw "Транскрибация не завершена для $($department.name)."
        }
    }

    foreach ($department in $config.departments) {
        if (Test-Stage $department "analysis") { continue }
        $schema = if ($department.analysisSchemaVersion) { $department.analysisSchemaVersion } else { "calls-strict-2.1" }
        Set-Status "Строгий анализ: $($department.name), схема $schema"
        & $python "scripts\analyze_calls_strict.py" --input "$($department.transcriptsDir)\all_transcripts.jsonl" `
            --output-dir $department.analysisDir --model $PrimaryModel --num-ctx 8192 --timeout 900 --retries 2 `
            --analysis-schema-version $schema
        if (-not (Test-Stage $department "analysis")) {
            Set-Status "Резервная модель: $($department.name)"
            & $python "scripts\analyze_calls_strict.py" --input "$($department.transcriptsDir)\all_transcripts.jsonl" `
                --output-dir $department.analysisDir --model $FallbackModel --num-ctx 8192 --timeout 1200 --retries 2 `
                --analysis-schema-version $schema
        }
        if (-not (Test-Stage $department "analysis")) { throw "Анализ не завершён для $($department.name)." }
    }

    Set-Status "Сборка Excel"
    & $node "workbook_build\august_three_departments_report_build.mjs" $resolvedConfig
    if ($LASTEXITCODE -ne 0) { throw "Сборка Excel завершилась ошибкой." }

    Set-Status "Проверка Excel"
    & $node "workbook_build\audit_august_three_departments_report.mjs" $resolvedConfig
    if ($LASTEXITCODE -ne 0) { throw "Итоговая книга не прошла аудит." }
    Set-Status "Готово: $($config.outputDir)\$($config.outputFile)"
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
