# Аналитика телефонных звонков

Локальный конвейер для расшифровки телефонных звонков, строгой оценки работы менеджеров и формирования итогового Excel-отчёта.

Проект рассчитан прежде всего на Windows. Распознавание выполняет `faster-whisper`, содержательный анализ — локальная модель через Ollama, итоговую книгу создаёт `@oai/artifact-tool` из среды Codex Desktop.

## Что делает проект

1. Проверяет количество MP3-файлов и сопоставляет каждый звонок с историей телефонии.
2. Определяет менеджера по номеру линии, клиенту и времени звонка.
3. Расшифровывает аудио моделью Whisper `large-v3`.
4. Анализирует разговор локальной моделью Ollama.
5. Отделяет клиентские звонки от внутренних разговоров менеджеров, склада, водителей и курьеров.
6. Рассчитывает строгую оценку по фиксированным критериям.
7. Формирует Excel с детализацией, сводкой, рейтингом, критериями и словами-паразитами.
8. Проверяет формулы, категории, менеджеров, количество строк и отсутствие китайского текста.

Итоговая книга содержит восемь листов:

- `ТЗ`;
- `сводка`;
- `каждый звонок`;
- `менеджер средний показатель`;
- `средние показатели отдела`;
- `рейтинг менеджеров`;
- `Критерии оценки`;
- `Слова-паразиты`.

## Важно о персональных данных

Репозиторий публичный. В него намеренно **не входят**:

- записи звонков;
- выгрузки истории телефонии;
- телефонные номера и сопоставления менеджеров;
- транскрипты;
- результаты анализа;
- готовые отчёты;
- локальные конфигурации отделов;
- виртуальное окружение и модели.

Эти данные исключены через `.gitignore`. Перед переустановкой Windows сохраните их отдельно на зашифрованном диске или в другом защищённом хранилище. GitHub не заменяет резервную копию исходных звонков.

## Системные требования

- Windows 10 или Windows 11 x64;
- Python 3.11 рекомендуется;
- Codex Desktop для среды `@oai/artifact-tool`;
- Ollama;
- NVIDIA GPU с актуальным драйвером рекомендуется;
- свободное место для моделей Whisper и Ollama;
- PowerShell 5.1 или новее.

Проект может транскрибировать на CPU, но это значительно медленнее.

## Восстановление после переустановки Windows

### 1. Клонировать репозиторий

```powershell
git clone https://github.com/Vladislav-Yurievich/call_analytics.git
cd call_analytics
```

### 2. Установить программы

Установите:

1. [Python](https://www.python.org/downloads/windows/) 3.11 x64.
2. [Ollama](https://ollama.com/download/windows).
3. Codex Desktop.
4. Драйвер NVIDIA, если будет использоваться GPU.

После установки Ollama загрузите основную модель:

```powershell
ollama pull qwen2.5:7b
```

Резервная модель необязательна, но полезна для повторной обработки результатов, не прошедших проверку:

```powershell
ollama pull qwen3:14b
```

### 3. Подготовить Python и Artifact Tool

Откройте проект в Codex Desktop хотя бы один раз, затем выполните:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup_windows.ps1
```

Скрипт:

- создаст `.venv_transcribe`;
- установит `faster-whisper` и CUDA-библиотеки;
- создаст локальную ссылку `workbook_build/node_modules` на среду Codex;
- проверит наличие Ollama.

Для работы только на CPU:

```powershell
.\scripts\setup_windows.ps1 -CpuOnly
```

## Подготовка данных отдела

Создайте в корне проекта папку, например:

```text
department_calls_mp3/
├── 79000000000_in_79200000000_2026_09_01-10_15_30_abcd.mp3
├── 79000000001_in_79200000000_2026_09_01-10_20_10_efgh.mp3
└── История внешних звонков.xlsx
```

Ожидаемый формат имени записи:

```text
<номер клиента>_<in|out>_<номер линии>_<ГГГГ_ММ_ДД>-<ЧЧ_ММ_СС>_<id>.mp3
```

Поддерживаются две структуры истории:

1. Расширенная выгрузка с колонками клиента, сотрудника, линии переадресации, даты и времени.
2. Компактная выгрузка, где сотрудник указан непосредственно рядом с клиентом, датой и временем.

Перед транскрибацией `preflight_four_departments.mjs` требует однозначного сопоставления каждого MP3 с историей. При неоднозначности процесс остановится, чтобы звонок не попал к неверному менеджеру.

## Настройка отчёта

Скопируйте пример:

```powershell
Copy-Item .\workbook_build\report_config.example.json .\workbook_build\my_report_config.json
```

Основные поля конфигурации:

| Поле | Назначение |
|---|---|
| `key` | Короткий уникальный идентификатор отдела латиницей |
| `name` | Название отдела в итоговом Excel |
| `expectedCalls` | Точное ожидаемое количество MP3 |
| `inputDir` | Папка с MP3 и историей |
| `transcriptsDir` | Папка для транскриптов |
| `analysisDir` | Папка для результатов анализа |
| `historyPath` | Путь к Excel с историей звонков |
| `analysisSchemaVersion` | Версия правил анализа |
| `outputDir` | Папка итогового отчёта |
| `outputFile` | Имя итогового XLSX |

В одном конфиге может быть несколько отделов. Для каждого добавьте отдельный объект в массив `departments`.

### Версии правил анализа

- `calls-strict-2.1` — основная строгая схема. Оценка разговора, внутренние звонки, красные флаги, слова-паразиты. Используйте её по умолчанию.
- `calls-strict-2.2` — московская схема. Дополнительно проверяет предложение оформить покупку через стороннее юридическое лицо и добавляет два столбца в детализацию.

Для обычного отдела используйте `calls-strict-2.1`.

## Запуск полного конвейера

Убедитесь, что Ollama запущена, затем выполните:

```powershell
.\scripts\run_department_strict.ps1 -ConfigPath "workbook_build\my_report_config.json"
```

Запуск на CPU:

```powershell
.\scripts\run_department_strict.ps1 `
  -ConfigPath "workbook_build\my_report_config.json" `
  -CpuOnly
```

Скрипт последовательно выполняет:

1. проверку истории и менеджеров;
2. транскрибацию всех отделов;
3. строгий анализ;
4. резервный анализ невалидных результатов;
5. сборку Excel;
6. автоматический аудит книги.

Готовые валидные JSON повторно не вычисляются. После остановки компьютера или ошибки достаточно запустить ту же команду ещё раз.

Текущий этап записывается в `pipeline_status.txt`. Этот файл служебный и не попадает в Git.

## Ручной запуск отдельных этапов

### Проверка исходников

```powershell
$node = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node .\workbook_build\preflight_four_departments.mjs .\workbook_build\my_report_config.json
```

### Транскрибация

```powershell
.\.venv_transcribe\Scripts\python.exe .\scripts\transcribe_calls.py `
  --input-dir department_calls_mp3 `
  --output-dir transcripts_department `
  --model large-v3 `
  --device cuda `
  --compute-type float16 `
  --beam-size 5 `
  --best-of 5 `
  --language-detection-segments 3
```

### Анализ

```powershell
.\.venv_transcribe\Scripts\python.exe .\scripts\analyze_calls_strict.py `
  --input transcripts_department\all_transcripts.jsonl `
  --output-dir analysis_department_strict_qwen25 `
  --model qwen2.5:7b `
  --num-ctx 8192 `
  --timeout 900 `
  --retries 2 `
  --analysis-schema-version calls-strict-2.1
```

### Сборка и проверка Excel

```powershell
$node = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node .\workbook_build\august_three_departments_report_build.mjs .\workbook_build\my_report_config.json
& $node .\workbook_build\audit_august_three_departments_report.mjs .\workbook_build\my_report_config.json
```

## Проверка кода

Python-тесты:

```powershell
Push-Location .\scripts
& ..\.venv_transcribe\Scripts\python.exe -m unittest test_strict_analysis.py
Pop-Location
```

Тесты сопоставления истории:

```powershell
$node = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node --test .\workbook_build\strict_history_mapping.test.mjs
```

## Структура репозитория

```text
scripts/
├── transcribe_calls.py                 # распознавание аудио
├── analyze_calls_strict.py             # строгий анализ через Ollama
├── check_four_department_results.py     # проверка и восстановление манифестов
├── run_department_strict.ps1            # универсальный запуск
├── setup_windows.ps1                    # настройка Windows
└── test_strict_analysis.py              # тесты анализа

workbook_build/
├── preflight_four_departments.mjs       # проверка исходников и истории
├── strict_history_mapping.mjs           # сопоставление звонков и менеджеров
├── august_three_departments_report_build.mjs
├── audit_august_three_departments_report.mjs
└── report_config.example.json

Аналитика_звонков.xlsx                   # шаблон итоговой книги
```

## Возможные проблемы

### `Ollama` не отвечает

Проверьте, что приложение Ollama запущено:

```powershell
ollama list
```

### Не найден `@oai/artifact-tool`

Откройте проект в Codex Desktop и повторите:

```powershell
.\scripts\setup_windows.ps1
```

### Ошибка CUDA или не найдены DLL

1. Обновите драйвер NVIDIA.
2. Повторно установите зависимости:

```powershell
.\.venv_transcribe\Scripts\python.exe -m pip install -r requirements-cuda.txt
```

3. Либо запустите обработку с `-CpuOnly`.

### Звонок не сопоставлен с историей

Проверьте:

- номер клиента в имени файла и истории;
- дату и время;
- номер линии;
- отсутствие нескольких строк с одинаковым временем и разными менеджерами;
- значение `expectedCalls` в конфигурации.

Не отключайте строгую проверку ради продолжения обработки: неверное сопоставление искажает рейтинг менеджеров.

## Что сохранить отдельно перед переустановкой

Скопируйте в защищённое хранилище:

- все папки `*_calls_mp3` и `call_*_mp3`;
- файлы истории звонков;
- при необходимости готовые `transcripts*` и `analysis*`, чтобы не пересчитывать их;
- папку `outputs` с итоговыми отчётами;
- локальные `*_report_config.json`, если в них есть нужные сопоставления.

После клонирования репозитория верните эти папки в корень проекта. Их названия должны совпадать с путями в конфигурации.

