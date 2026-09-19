import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { historyRecords, matchHistory } from "./strict_history_mapping.mjs";

const configPath = process.argv[2];
if (!configPath) throw new Error("Usage: node august_three_departments_report_build.mjs <config.json>");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const templatePath = config.templatePath || "Аналитика_звонков.xlsx";
const departments = config.departments;
const outputDir = config.outputDir;
const outputPath = `${outputDir}/${config.outputFile}`;
const previewDir = `${outputDir}/previews`;
const reportTitle = config.reportTitle || "Аналитика звонков компании «Железная мебель»";

if (!Array.isArray(departments) || !departments.length) {
  throw new Error("The config must contain a non-empty departments array.");
}
const includeUnauthorizedLegalEntity = departments.some(
  (department) => department.analysisSchemaVersion === "calls-strict-2.2",
);
const callsLastColumn = includeUnauthorizedLegalEntity ? "AF" : "AD";

const statusRu = {
  yes: "Да",
  no: "Нет",
  partial: "Частично",
  unclear: "Неясно",
  not_applicable: "Не применимо",
};

const categoryRu = {
  new_order: "Новый заказ",
  existing_order: "Уточнение существующего заказа",
  consultation_without_clear_order: "Консультация без явного заказа",
  internal_operational: "Внутренний / служебный звонок",
  spam_or_non_target: "Спам / нецелевой звонок",
  missed_call_or_too_short: "Короткий / пропущенный звонок",
  unclear: "Неясно",
};

const displayCodeRu = {
  ...categoryRu,
  yes: "Да",
  no: "Нет",
  partial: "Частично",
  not_applicable: "Не применимо",
};

function normalizeManagerName(value) {
  const manager = clean(value, 100);
  if (/^авито$/iu.test(manager)) return "Не определён (линия Авито)";
  return manager || "Не определён";
}

const redFlagLabels = {
  redirected_to_website: "Отправили на сайт вместо консультации",
  third_party_card_transfer: "Перевод денег на личную/чужую карту",
  profanity_or_insult: "Нецензурная лексика или оскорбление",
  rude_or_dismissive_communication: "Грубое или обесценивающее общение",
  sensitive_payment_data_request: "Запрос конфиденциальных платёжных данных",
  unresolved_complaint_or_conflict: "Жалоба или конфликт оставлены без решения",
  unauthorized_legal_entity_offer: "Предложение купить через стороннее юридическое лицо",
};

const scoringCriteria = [
  { key: "manager_introduced", label: "Представился", weight: 7, yes: "Назвал имя и компанию", partial: "Назвал только имя или только компанию", no: "Не представился", notApplicable: "Только для нецелевых, внутренних и слишком коротких звонков" },
  { key: "asked_client_name", label: "Спросил имя клиента", weight: 3, yes: "Прямо спросил или подтвердил, как обращаться", partial: "Косвенно попросил представиться", no: "Не спрашивал", notApplicable: "Нецелевой, внутренний или слишком короткий звонок" },
  { key: "client_name_learned_or_used", label: "Узнал и использовал имя", weight: 5, yes: "Имя известно и менеджер обратился по имени", partial: "Имя известно, но менеджер его не использовал", no: "Имя не узнал и по имени не обращался", notApplicable: "Нецелевой, внутренний или слишком короткий звонок" },
  { key: "client_organization_identified", label: "Организация клиента", weight: 8, yes: "Установлены название и профиль/назначение закупки", partial: "Установлено только название либо профиль", no: "Для корпоративного клиента ничего не установлено", notApplicable: "Клиент явно покупает как физлицо" },
  { key: "needs_product_quantity_deadline", label: "Товар, количество и срок", weight: 15, yes: "Установлены товар, количество и срок", partial: "Установлены один или два элемента", no: "Не установлен ни один элемент", notApplicable: "Нецелевой, внутренний или слишком короткий звонок" },
  { key: "needs_use_and_location", label: "Назначение и место", weight: 10, yes: "Установлены назначение и место размещения", partial: "Установлено только одно", no: "Ничего не выяснено", notApplicable: "Вопрос объективно не относится к товару/ситуации" },
  { key: "offered_alternative", label: "Предложил альтернативу", weight: 8, yes: "При проблеме предложен конкретный аналог/вариант", partial: "Предложено абстрактно, без конкретики", no: "Альтернатива нужна, но не предложена", notApplicable: "Исходный вариант полностью подходит" },
  { key: "offered_additional_products_services", label: "Дополнительные товары и услуги", weight: 7, yes: "Предложена конкретная услуга или сопутствующий товар", partial: "Услуга только упомянута", no: "Была возможность, но ничего не предложено", notApplicable: "Обсуждение не дошло до комплектации/поставки" },
  { key: "handled_objections", label: "Работа с возражениями", weight: 10, yes: "Возражение уточнено и дано конкретное решение", partial: "Ответ есть, но без уточнения или решения", no: "Возражение проигнорировано/обесценено", notApplicable: "Клиент не высказывал возражений" },
  { key: "clarified_decision_timing", label: "Срок принятия решения", weight: 5, yes: "Выяснен срок решения или оплаты", partial: "Решение обсуждалось без срока", no: "Срок был важен, но не выяснен", notApplicable: "Заказ оформляется/оплачивается сразу" },
  { key: "clarified_procurement_method", label: "Способ закупки", weight: 5, yes: "Выяснен счёт/прямая закупка/тендер/площадка", partial: "Способ следует из контекста, но не подтверждён", no: "Корпоративная закупка есть, способ не выяснен", notApplicable: "Физлицо или тема закупки не возникала" },
  { key: "summarized_agreements", label: "Резюмировал договорённости", weight: 5, yes: "Повторены действие и срок/ответственный", partial: "Повторена только часть", no: "Договорённости не резюмированы", notApplicable: "Договорённостей не возникло" },
  { key: "scheduled_next_step", label: "Назначил следующий шаг", weight: 8, yes: "Закреплено действие и срок либо получатель", partial: "Действие есть без срока/адресата", no: "Следующий шаг не закреплён", notApplicable: "Вопрос полностью решён и продолжение не нужно" },
  { key: "correct_farewell", label: "Корректное прощание", weight: 4, yes: "Есть вежливое прощание или благодарность", partial: "Только нейтральное «хорошо/ладно»", no: "Нет корректного окончания", notApplicable: "Конец записи отсутствует или звонок оборван технически" },
];

const metricDefinitions = scoringCriteria.map((criterion, index) => ({
  ...criterion,
  column: String.fromCharCode("G".charCodeAt(0) + index),
}));

const summaryDefinitions = scoringCriteria.map((criterion, index) => ({
  key: criterion.key,
  label: `${index + 1}. ${criterion.label}`,
}));

const blue = "#255785";
const lightBlue = "#DCE6F1";
const paleGreen = "#E2F0D9";
const paleRed = "#FCE4D6";
const paleYellow = "#FFF2CC";
const paleGray = "#E7E6E6";
const thinBorder = { preset: "all", style: "thin", color: "#D9E2F3" };

function replaceDisplayCodes(value) {
  let text = String(value ?? "");
  for (const [code, label] of Object.entries(displayCodeRu)) {
    text = text.replace(new RegExp(`\\b${code}\\b`, "gi"), label);
  }
  return text;
}

const clean = (value, max = 600) => replaceDisplayCodes(value).replace(/\s+/g, " ").trim().slice(0, max).trim();
const digits = (value) => String(value ?? "").replace(/\D/g, "");
const status = (analysis, key) => analysis?.checks?.[key]?.status || "unclear";
const ruStatus = (value) => statusRu[value] || statusRu.unclear;

function combineStatuses(...values) {
  const unique = values.filter(Boolean);
  if (unique.includes("yes")) return "yes";
  if (unique.includes("partial")) return "partial";
  if (unique.includes("no")) return "no";
  if (unique.includes("unclear")) return "unclear";
  return "not_applicable";
}

function excelDateTime(dateSerial, timeSerial) {
  if (!Number.isFinite(Number(dateSerial)) || !Number.isFinite(Number(timeSerial))) return "";
  const epoch = Date.UTC(1899, 11, 30);
  const milliseconds = Math.round((Number(dateSerial) + Number(timeSerial)) * 86400000);
  const date = new Date(epoch + milliseconds);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function displayDateTime(value) {
  const match = String(value ?? "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}` : clean(value, 40);
}

function isoMilliseconds(value) {
  const match = String(value ?? "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return NaN;
  return Date.UTC(...match.slice(1).map(Number).map((part, index) => index === 1 ? part - 1 : part));
}

function strictScore(analysis) {
  if (analysis?.quality_percent === null || analysis?.quality_percent === undefined || analysis?.quality_percent === "") return null;
  const earned = Number(analysis?.earned_points);
  const applicable = Number(analysis?.applicable_points);
  return Number.isFinite(earned) && applicable > 0 ? earned / applicable : null;
}

function redFlagsText(analysis) {
  const rows = [];
  for (const [key, label] of Object.entries(redFlagLabels)) {
    const flag = analysis?.red_flags?.[key] || {};
    if (flag.status === "yes") {
      const evidence = clean(flag.evidence, 110);
      rows.push(evidence ? `${label}: ${evidence}` : label);
    }
  }
  return rows.length ? rows.join("; ") : null;
}

function unauthorizedEntityDetails(analysis) {
  const flag = analysis?.red_flags?.unauthorized_legal_entity_offer || {};
  if (flag.status !== "yes") return [null, null];
  return [clean(flag.detected_entity, 120), clean(flag.evidence, 240)];
}

function shortList(items, max = 340) {
  const joined = items.filter(Boolean).map((item) => clean(item, 180)).join("; ");
  return joined.length > max ? `${joined.slice(0, max - 1).trim()}…` : joined;
}

function visibleStatuses(analysis) {
  return Object.fromEntries(scoringCriteria.map((criterion) => [criterion.key, status(analysis, criterion.key)]));
}

function statusCounts(values) {
  const result = { yes: 0, no: 0, partial: 0, unclear: 0, not_applicable: 0 };
  for (const value of values) result[value in result ? value : "unclear"] += 1;
  return result;
}

function percentageFromCounts(counts) {
  const applicable = counts.yes + counts.no + counts.partial;
  return applicable ? (counts.yes + counts.partial * 0.5) / applicable : 0;
}

function callFillerText(analysis) {
  const rows = Array.isArray(analysis?.manager_filler_words) ? analysis.manager_filler_words : [];
  return rows.length
    ? rows.map((row) => `${clean(row.phrase, 60)} - ${Number(row.count) || 0}`).join("; ")
    : "Не выявлены";
}

function aggregateFillerWords(managerCalls) {
  const phrases = new Map();
  for (const call of managerCalls) {
    for (const row of Array.isArray(call.analysis?.manager_filler_words) ? call.analysis.manager_filler_words : []) {
      const phrase = clean(row.phrase, 60).toLowerCase();
      if (!phrase) continue;
      const current = phrases.get(phrase) || { phrase, occurrences: 0, calls: 0, evidence: [] };
      current.occurrences += Number(row.count) || 0;
      current.calls += 1;
      const evidence = clean(row.evidence, 180);
      if (evidence && current.evidence.length < 2 && !current.evidence.includes(evidence)) current.evidence.push(evidence);
      phrases.set(phrase, current);
    }
  }
  return [...phrases.values()].sort((left, right) => right.occurrences - left.occurrences || left.phrase.localeCompare(right.phrase, "ru"));
}

function findHistoryMatch(historyIndex, record) {
  const meta = record?.metadata_from_filename || {};
  const source = digits(meta.source_number);
  const target = digits(meta.target_number);
  const callDateTime = clean(meta.call_datetime, 30);
  const exact = historyIndex.exact.get(`${source}|${callDateTime}`) || [];
  if (exact.length) return exact[0];

  const candidates = historyIndex.bySource.get(source) || [];
  const targetMs = isoMilliseconds(callDateTime);
  const targetTimes = [targetMs, targetMs + 2 * 60 * 60 * 1000, targetMs - 2 * 60 * 60 * 1000]
    .filter((value) => Number.isFinite(value));
  const nearCandidates = candidates
    .map((candidate) => {
      const candidateMs = isoMilliseconds(candidate.callDateTime);
      const distance = Math.min(...targetTimes.map((value) => Math.abs(candidateMs - value)));
      return { candidate, distance };
    })
    .filter(({ distance }) => Number.isFinite(distance) && distance <= 120000)
    .sort((left, right) => left.distance - right.distance);

  const internalCandidates = historyIndex.byInternal.get(target) || [];
  const managers = [...new Set(internalCandidates.map((candidate) => candidate.manager))];
  if (nearCandidates.length) {
    if (managers.length === 1) {
      const sameManager = nearCandidates.find(({ candidate }) => candidate.manager === managers[0]);
      if (sameManager) return sameManager.candidate;
    }
    return nearCandidates[0].candidate;
  }
  return managers.length === 1 ? internalCandidates[0] : null;
}

function aggregateNarrative(calls) {
  const metrics = metricDefinitions.map((definition) => {
    const values = calls.map((call) => call.visible[definition.key]);
    const count = statusCounts(values);
    const applicable = count.yes + count.no + count.partial;
    return { ...definition, count, rate: applicable ? (count.yes + count.partial * 0.5) / applicable : null };
  });
  const measured = metrics.filter((metric) => metric.rate !== null);
  const strongest = [...measured].sort((a, b) => b.rate - a.rate).slice(0, 2);
  const weakest = [...measured].sort((a, b) => a.rate - b.rate).slice(0, 3);
  const strongText = strongest.length ? strongest.map((metric) => `${metric.label} ${Math.round(metric.rate * 100)}%`).join(", ") : "недостаточно применимых данных";
  const weakText = weakest.length ? weakest.map((metric) => `${metric.label} ${Math.round(metric.rate * 100)}%`).join(", ") : "нет";
  const missed = weakest.length ? `Чаще всего не выполнено: ${weakest.map((metric) => metric.label.toLowerCase()).join(", ")}.` : "Явные повторяющиеся упущения не выделены.";
  const flags = Object.keys(redFlagLabels).map((key) => ({ key, count: calls.filter((call) => call.analysis?.red_flags?.[key]?.status === "yes").length })).filter((row) => row.count);
  return {
    conclusion: `Сильные стороны: ${strongText}. Основные зоны роста: ${weakText}.`,
    recommendation: weakest.length ? `В приоритете отработать: ${weakest.map((metric) => metric.label.toLowerCase()).join(", ")}.` : "Сохранять текущий стандарт консультации и закрепления следующего шага.",
    missed,
    flags: flags.length ? flags.map((row) => `${redFlagLabels[row.key]}: ${row.count}`).join("; ") : "Не выявлены",
  };
}

function managerMetricFormula(managerRow, statusColumn, callEnd) {
  const calls = "'каждый звонок'";
  const managerRange = `${calls}!$B$3:$B$${callEnd}`;
  const statusRange = `${calls}!$${statusColumn}$3:$${statusColumn}$${callEnd}`;
  const yes = `COUNTIFS(${managerRange},$B${managerRow},${statusRange},"Да")`;
  const partial = `COUNTIFS(${managerRange},$B${managerRow},${statusRange},"Частично")`;
  const no = `COUNTIFS(${managerRange},$B${managerRow},${statusRange},"Нет")`;
  return `=IFERROR((${yes}+0.5*${partial})/(${yes}+${partial}+${no}),"")`;
}

function formulaText(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function departmentManagers(departmentName) {
  return managers.filter((manager) => manager.endsWith(` (${departmentName})`));
}

function departmentMetricFormula(departmentName, statusColumn, callEnd) {
  const calls = "'каждый звонок'";
  const managerRange = `${calls}!$B$3:$B$${callEnd}`;
  const statusRange = `${calls}!$${statusColumn}$3:$${statusColumn}$${callEnd}`;
  const countStatus = (statusValue) => {
    const terms = departmentManagers(departmentName).map((manager) =>
      `COUNTIFS(${managerRange},${formulaText(manager)},${statusRange},${formulaText(statusValue)})`,
    );
    return `(${terms.join("+") || "0"})`;
  };
  const yes = countStatus(statusRu.yes);
  const partial = countStatus(statusRu.partial);
  const no = countStatus(statusRu.no);
  return `=IFERROR((${yes}+0.5*${partial})/(${yes}+${partial}+${no}),"")`;
}

function departmentScoreFormula(departmentName, callEnd) {
  const callsSheet = "'каждый звонок'";
  const managerRange = `${callsSheet}!$B$3:$B$${callEnd}`;
  const scoreRange = `${callsSheet}!$AA$3:$AA$${callEnd}`;
  const categoryRange = `${callsSheet}!$E$3:$E$${callEnd}`;
  const applicableRange = `${callsSheet}!$Z$3:$Z$${callEnd}`;
  const departmentManagerNames = departmentManagers(departmentName);
  const sums = departmentManagerNames.map((manager) =>
    `SUMIF(${managerRange},${formulaText(manager)},${scoreRange})`,
  );
  const counts = departmentManagerNames.map((manager) =>
    `COUNTIFS(${managerRange},${formulaText(manager)},${applicableRange},">=35",${categoryRange},"<>Внутренний / служебный звонок",${categoryRange},"<>Спам / нецелевой звонок",${categoryRange},"<>Короткий / пропущенный звонок")`,
  );
  return `=IFERROR((${sums.join("+") || "0"})/(${counts.join("+") || "0"}),"")`;
}

function styleStatusRange(range) {
  range.conditionalFormats.add("containsText", { text: "Да", format: { fill: paleGreen } });
  range.conditionalFormats.add("containsText", { text: "Нет", format: { fill: paleRed } });
  range.conditionalFormats.add("containsText", { text: "Частично", format: { fill: paleYellow } });
  range.conditionalFormats.add("containsText", { text: "Неясно", format: { fill: paleGray } });
  range.conditionalFormats.add("containsText", { text: "Не применимо", format: { fill: paleGray } });
}

const templateBlob = await FileBlob.load(templatePath);
const workbook = await SpreadsheetFile.importXlsx(templateBlob);
const legacyCallsSheet = workbook.worksheets.getItem("каджый звонок");
legacyCallsSheet.name = "каждый звонок";
const calls = [];
const departmentAudit = [];

for (const department of departments) {
  const historyBlob = await FileBlob.load(department.historyPath);
  const historyWorkbook = await SpreadsheetFile.importXlsx(historyBlob);
  const rawHistoryRows = historyWorkbook.worksheets.getItem("Sheet1").getUsedRange().values;
  const strictRecords = config.strictHistoryMapping ? historyRecords(rawHistoryRows, department.managerOverrides) : null;
  const historyRows = rawHistoryRows.slice(12);
  const historyIndex = { exact: new Map(), bySource: new Map(), byInternal: new Map() };
  for (const row of historyRows) {
    const client = digits(row[1]);
    const callDateTime = excelDateTime(row[7], row[8]);
    const manager = clean(row[2], 100).replace(/\s*\([^)]*\)\s*$/u, "").trim();
    if (!client || !callDateTime || !manager) continue;
    const item = { client, callDateTime, manager };
    const exactKey = `${client}|${callDateTime}`;
    historyIndex.exact.set(exactKey, [...(historyIndex.exact.get(exactKey) || []), item]);
    historyIndex.bySource.set(client, [...(historyIndex.bySource.get(client) || []), item]);
    for (const internal of [digits(row[4]), digits(row[6])].filter(Boolean)) {
      historyIndex.byInternal.set(internal, [...(historyIndex.byInternal.get(internal) || []), item]);
    }
  }

  const analysisLines = (await fs.readFile(department.analysisPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean);
  const analysisRows = analysisLines.map((line) => JSON.parse(line));
  if (department.expectedCalls != null && analysisRows.length !== department.expectedCalls) {
    throw new Error(`${department.name}: expected ${department.expectedCalls} analyses, found ${analysisRows.length}`);
  }
  if (new Set(analysisRows.map((item) => item.record?.file_name)).size !== analysisRows.length) {
    throw new Error(`${department.name}: duplicate call records in analysis manifest`);
  }
  const invalidLanguage = analysisRows.find((item) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{323af}]/u.test(JSON.stringify(item.analysis || {})));
  if (invalidLanguage) {
    throw new Error(`В анализе ${invalidLanguage.record?.file_name || "неизвестного звонка"} найден китайский текст. Сначала повторите анализ звонка.`);
  }
  const departmentCalls = analysisRows.map((item) => {
    const history = strictRecords
      ? matchHistory(strictRecords, item.record?.metadata_from_filename || {})
      : findHistoryMatch(historyIndex, item.record);
    const analysis = item.analysis || {};
    const meta = item.record?.metadata_from_filename || {};
    const visible = visibleStatuses(analysis);
    const visibleScore = strictScore(analysis);
    const managerName = normalizeManagerName(history?.manager);
    return {
      record: item.record,
      analysis,
      departmentKey: department.key,
      departmentName: department.name,
      managerName,
      manager: `${managerName} (${department.name})`,
      matchedHistory: Boolean(history),
      dateTime: clean(meta.call_datetime, 30),
      sourceNumber: digits(meta.source_number),
      visible,
      visibleScore,
    };
  });
  calls.push(...departmentCalls);
  departmentAudit.push({
    department: department.name,
    calls: departmentCalls.length,
    unmatchedHistory: departmentCalls.filter((call) => !call.matchedHistory).length,
  });
}

calls.sort((left, right) => left.dateTime.localeCompare(right.dateTime));
const unmatched = calls.filter((call) => !call.matchedHistory).length;
if (unmatched && config.strictHistoryMapping) throw new Error(`Не сопоставлено со справочниками истории: ${unmatched}`);
if (unmatched) console.warn(`Не сопоставлено со справочниками истории: ${unmatched}`);
if (!calls.length) throw new Error("Нет результатов анализа для построения отчёта.");

const dates = calls.map((call) => call.dateTime).filter(Boolean).sort();
const period = `${displayDateTime(dates[0]).slice(0, 10)}-${displayDateTime(dates.at(-1)).slice(0, 10)}`;
const callEnd = calls.length + 2;
const managers = [...new Set(calls.map((call) => call.manager))]
  .filter((manager) => !manager.startsWith("Не определён"))
  .sort((left, right) => left.localeCompare(right, "ru"));

for (const sheetName of ["сводка", "каждый звонок", "менеджер средний показатель", "средние показатели отдела", "рейтинг менеджеров"]) {
  const sheet = workbook.worksheets.getItem(sheetName);
  for (const table of [...sheet.tables.items]) table.delete();
}

const taskSheet = workbook.worksheets.getItem("ТЗ");
taskSheet.getRange("A2:B4").values = [
  ["1. Представился менеджер", "Да: названы имя менеджера и компания; Частично: названо только имя или только компания; Нет: представления не было"],
  ["2. Спросил имя клиента", "Небольшой вес: Да только при прямом вопросе или подтверждении, как обращаться; Частично: косвенная просьба представиться; Нет: не спрашивал"],
  ["3. Имя клиента и организация", "Отдельно проверяется, стало ли имя клиента известно и обращался ли менеджер по имени. Для корпоративного клиента проверяются название и профиль организации"],
];
taskSheet.getRange("A22:B29").values = [
  ["Красные флаги", "Когда фиксируется"],
  ["Отправили на сайт вместо консультации", "Клиента отправили смотреть сайт без предметной консультации"],
  ["Перевод денег на личную/чужую карту", "Есть явное предложение оплатить на карту физлица или третьего лица"],
  ["Нецензурная лексика или оскорбление", "Есть мат, оскорбление или унижение участника разговора"],
  ["Грубое или обесценивающее общение", "Есть давление, грубость или пренебрежение без мата"],
  ["Запрос конфиденциальных платёжных данных", "Просят PIN, CVV, пароль или код из СМС"],
  ["Жалоба или конфликт оставлены без решения", "Менеджер не пытается помочь при явной жалобе клиента"],
  ["Не является красным флагом", "«Карта предприятия», «карточка организации» и «реквизиты компании» означают данные организации. Это не перевод денег на банковскую карту."],
];
taskSheet.getRange("A22:B22").format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", wrapText: true, borders: thinBorder };
taskSheet.getRange("A23:B29").format = { wrapText: true, verticalAlignment: "top", borders: thinBorder };
taskSheet.getRange("A22:A29").format.columnWidth = 34;
taskSheet.getRange("B22:B29").format.columnWidth = 92;
taskSheet.getRange("A22:B29").format.rowHeight = 38;

const criteriaSheet = workbook.worksheets.items.find((sheet) => sheet.name === "Критерии оценки") || workbook.worksheets.add("Критерии оценки");
for (const table of [...criteriaSheet.tables.items]) table.delete();
criteriaSheet.getRange("A1:G30").clear({ applyTo: "all" });
criteriaSheet.getRange("A1:G2").unmerge();
criteriaSheet.getRange("A1:G1").values = [["Строгая система оценки качества звонка", "", "", "", "", "", ""]];
criteriaSheet.getRange("A2:G2").values = [["Итог рассчитывается только из видимых статусов: «Да» = 100% веса, «Частично» = 50%, «Нет» = 0. Неприменимые пункты не снижают оценку.", "", "", "", "", "", ""]];
criteriaSheet.getRange("A1:G1").merge();
criteriaSheet.getRange("A2:G2").merge();
criteriaSheet.getRange("A3:G3").values = [["№", "Критерий", "Вес, баллов", "Да", "Частично", "Нет", "Не применимо"]];
criteriaSheet.getRange("A4:G17").values = scoringCriteria.map((criterion, index) => [
  index + 1,
  criterion.label,
  criterion.weight,
  criterion.yes,
  criterion.partial,
  criterion.no,
  criterion.notApplicable,
]);
criteriaSheet.getRange("A18:C18").values = [["", "Итого возможных баллов", scoringCriteria.reduce((total, criterion) => total + criterion.weight, 0)]];
criteriaSheet.getRange("C18").formulas = [["=SUM(C4:C17)"]];
const criteriaRules = [
  ["Правило", "Применение"],
  ["Минимум для оценки", "Если применимо менее 35 баллов, процент не рассчитывается: контекста недостаточно."],
  ["Исключённые категории", "Внутренние/служебные, спам/нецелевые и короткие/пропущенные звонки не участвуют в средних и рейтинге."],
  ["Имя клиента", "3 балла начисляются за вопрос об имени; отдельно до 5 баллов - за то, что имя действительно установлено и использовано в разговоре."],
  ["Карта организации", "«Карта предприятия», «карточка организации» и реквизиты компании не являются красным флагом."],
  ["Перевод на карту", "Красный флаг ставится только при явном предложении перевести деньги на личную банковскую карту или карту третьего лица."],
  ...(includeUnauthorizedLegalEntity ? [
    ["Стороннее юридическое лицо", "Красный флаг ставится только при явном предложении оформить покупку, счёт или договор от имени продавца, которого нет в утверждённом списке."],
    ["Разрешённые продавцы", "ООО «Железная-Мебель»; ООО «Железная-МебельЮГ»; ООО «Металлическая Мебель»; ООО «МИР»; ООО «Айронэкс»; ИП Борисов П.Е.; ИП Ядрышникова Т.О.; ИП Алешина О.Ю."],
  ] : []),
  ["Проверяемость", "В строке каждого звонка показаны набранные и применимые баллы, процент и текстовая расшифровка."],
];
const criteriaLastRow = 19 + criteriaRules.length;
criteriaSheet.getRange("A20:B30").clear({ applyTo: "all" });
criteriaSheet.getRange(`A20:B${criteriaLastRow}`).values = criteriaRules;
criteriaSheet.getRange("A1:G1").format = { fill: lightBlue, font: { bold: true, size: 14 }, verticalAlignment: "center" };
criteriaSheet.getRange("A2:G2").format = { wrapText: true, verticalAlignment: "center" };
criteriaSheet.getRange("A3:G3").format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true, borders: thinBorder };
criteriaSheet.getRange("A4:G17").format = { wrapText: true, verticalAlignment: "top", borders: thinBorder };
criteriaSheet.getRange("A18:C18").format = { fill: paleGreen, font: { bold: true }, borders: thinBorder };
criteriaSheet.getRange("A20:B20").format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", borders: thinBorder };
criteriaSheet.getRange(`A21:B${criteriaLastRow}`).format = { wrapText: true, verticalAlignment: "top", borders: thinBorder };
criteriaSheet.getRange(`A1:A${criteriaLastRow}`).format.columnWidth = 20;
criteriaSheet.getRange(`B1:B${criteriaLastRow}`).format.columnWidth = 31;
criteriaSheet.getRange(`C1:C${criteriaLastRow}`).format.columnWidth = 13;
criteriaSheet.getRange(`D1:G${criteriaLastRow}`).format.columnWidth = 38;
criteriaSheet.getRange("1:1").format.rowHeight = 28;
criteriaSheet.getRange("2:2").format.rowHeight = 32;
criteriaSheet.getRange("3:3").format.rowHeight = 40;
criteriaSheet.getRange("4:17").format.rowHeight = 52;
criteriaSheet.getRange("20:20").format.rowHeight = 28;
criteriaSheet.getRange(`21:${criteriaLastRow}`).format.rowHeight = 54;
if (includeUnauthorizedLegalEntity) criteriaSheet.getRange("27:27").format.rowHeight = 88;
criteriaSheet.freezePanes.freezeRows(3);
criteriaSheet.tables.add("A3:G17", true, "ScoringCriteriaTable");

const callsSheet = workbook.worksheets.getItem("каждый звонок");
callsSheet.getRange("A1:AF1").clear({ applyTo: "contents" });
callsSheet.getRange("A1").values = [["ФИО менеджера: анализ каждого звонка"]];
callsSheet.getRange(`A1:${callsLastColumn}1`).format = { fill: lightBlue, font: { bold: true, color: "#1F1F1F", size: 13 }, verticalAlignment: "center" };
callsSheet.getRange(`A2:${callsLastColumn}2`).values = [[
  "№", "Менеджер", "Дата", "Клиент", "Категория", "Товарная категория",
  ...scoringCriteria.map((criterion) => criterion.label),
  "Вывод", "Рекомендация", "Упущения", "Красные флаги", "Набрано баллов", "Применимо баллов", "% выполнения", "Расшифровка оценки", "Слова-паразиты менеджера", "Файл",
  ...(includeUnauthorizedLegalEntity ? ["Стороннее юридическое лицо", "Подтверждающая фраза"] : []),
]];
callsSheet.getRange(`A3:AF${callEnd}`).clear({ applyTo: "contents" });
const callValues = calls.map((call, index) => [
  index + 1,
  call.manager,
  displayDateTime(call.dateTime),
  clean(call.analysis.client_name, 80) || call.sourceNumber,
  categoryRu[call.analysis.call_category] || "Неясно",
  clean(call.analysis.product_category, 100),
  ...scoringCriteria.map((criterion) => ruStatus(call.visible[criterion.key])),
  clean(call.analysis.conclusion, 350),
  clean(call.analysis.recommendation, 350),
  shortList(call.analysis.missed_opportunities || []),
  redFlagsText(call.analysis),
  null,
  null,
  null,
  null,
  callFillerText(call.analysis),
  clean(call.record?.file_name, 160),
  ...(includeUnauthorizedLegalEntity ? unauthorizedEntityDetails(call.analysis) : []),
]);
callsSheet.getRange(`A3:${callsLastColumn}${callEnd}`).values = callValues;
const earnedTerms = metricDefinitions.map((definition, index) => `IF(${definition.column}3="Да",'Критерии оценки'!$C$${index + 4},IF(${definition.column}3="Частично",'Критерии оценки'!$C$${index + 4}*0.5,0))`);
const applicableTerms = metricDefinitions.map((definition, index) => `IF(OR(${definition.column}3="Да",${definition.column}3="Частично",${definition.column}3="Нет"),'Критерии оценки'!$C$${index + 4},0)`);
callsSheet.getRange("Y3").formulas = [[`=${earnedTerms.join("+")}`]];
callsSheet.getRange("Z3").formulas = [[`=${applicableTerms.join("+")}`]];
callsSheet.getRange("AA3").formulas = [[`=IF(OR(E3="Внутренний / служебный звонок",E3="Спам / нецелевой звонок",E3="Короткий / пропущенный звонок",Z3<35),"",IFERROR(Y3/Z3,""))`]];
callsSheet.getRange("AB3").formulas = [[`=IF(AA3="","Не оценивается",TEXT(Y3,"0.0")&" из "&TEXT(Z3,"0")&" баллов; "&TEXT(AA3,"0%"))`]];
for (const column of ["Y", "Z", "AA", "AB"]) callsSheet.getRange(`${column}3:${column}${callEnd}`).fillDown();
callsSheet.getRange(`A2:${callsLastColumn}2`).format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true, borders: thinBorder };
callsSheet.getRange(`A3:${callsLastColumn}${callEnd}`).format = { verticalAlignment: "top", wrapText: true, borders: thinBorder };
callsSheet.getRange(`A3:A${callEnd}`).format.horizontalAlignment = "center";
callsSheet.getRange(`G3:T${callEnd}`).format.horizontalAlignment = "center";
callsSheet.getRange(`Y3:Z${callEnd}`).format = { horizontalAlignment: "center", numberFormat: "0.0", borders: thinBorder };
callsSheet.getRange(`AA3:AA${callEnd}`).format = { horizontalAlignment: "center", numberFormat: "0%", borders: thinBorder };
callsSheet.getRange(`A1:A${callEnd}`).format.columnWidth = 7;
callsSheet.getRange(`B1:B${callEnd}`).format.columnWidth = 34;
callsSheet.getRange(`C1:C${callEnd}`).format.columnWidth = 18;
callsSheet.getRange(`D1:D${callEnd}`).format.columnWidth = 20;
callsSheet.getRange(`E1:E${callEnd}`).format.columnWidth = 29;
callsSheet.getRange(`F1:F${callEnd}`).format.columnWidth = 22;
callsSheet.getRange(`G1:T${callEnd}`).format.columnWidth = 17;
callsSheet.getRange(`U1:V${callEnd}`).format.columnWidth = 36;
callsSheet.getRange(`W1:X${callEnd}`).format.columnWidth = 40;
callsSheet.getRange(`Y1:AA${callEnd}`).format.columnWidth = 15;
callsSheet.getRange(`AB1:AB${callEnd}`).format.columnWidth = 27;
callsSheet.getRange(`AC1:AC${callEnd}`).format.columnWidth = 28;
callsSheet.getRange(`AD1:AD${callEnd}`).format.columnWidth = 50;
if (includeUnauthorizedLegalEntity) {
  callsSheet.getRange(`AE1:AE${callEnd}`).format.columnWidth = 30;
  callsSheet.getRange(`AF1:AF${callEnd}`).format.columnWidth = 48;
}
callsSheet.getRange("1:1").format.rowHeight = 26;
callsSheet.getRange("2:2").format.rowHeight = 56;
callsSheet.getRange(`3:${callEnd}`).format.rowHeight = 66;
callsSheet.freezePanes.freezeRows(2);
callsSheet.freezePanes.freezeColumns(2);
styleStatusRange(callsSheet.getRange(`G3:T${callEnd}`));
if (includeUnauthorizedLegalEntity) {
  callsSheet.getRange(`AE3:AF${callEnd}`).conditionalFormats.addCustom("=$AE3<>\"\"", {
    fill: "#FFC7CE",
    font: { bold: true, color: "#9C0006" },
  });
}
callsSheet.tables.add(`A2:${callsLastColumn}${callEnd}`, true, "CallsTable");

const summarySheet = workbook.worksheets.getItem("сводка");
summarySheet.getRange("A1:G1").clear({ applyTo: "contents" });
summarySheet.getRange("A1").values = [[reportTitle]];
summarySheet.getRange("A1:G1").format = { fill: blue, font: { bold: true, color: "#FFFFFF", size: 15 }, verticalAlignment: "center" };
summarySheet.getRange("A3:B12").values = [
  ["Метрика", "Значение"],
  ["Всего звонков", null],
  ["Целевой звонок (заказ)", null],
  ["Уточнения существующего заказа", null],
  ["Спам / нецелевые", null],
  ["Средний балл качества", null],
  ["Низкий балл (<=40%)", null],
  ["Есть красный флаг", null],
  ["Не уточнили имя клиента", null],
  ["Не назначен следующий шаг", null],
];
summarySheet.getRange("D3:F10").values = [
  ["Категория", "Звонков", "Доля"],
  ["Новый заказ", null, null],
  ["Уточнение существующего заказа", null, null],
  ["Консультация без явного заказа", null, null],
  ["Внутренний / служебный звонок", null, null],
  ["Спам / нецелевой звонок", null, null],
  ["Короткий / пропущенный звонок", null, null],
  ["Неясно", null, null],
];
summarySheet.getRange("A15:G29").values = [
  ["Критерий", "Да", "Нет", "Частично", "Неясно", "Не применимо", "Выполнение %"],
  ...summaryDefinitions.map((definition) => [definition.label, null, null, null, null, null, null]),
];
summarySheet.getRange("B4:B12").formulas = [
  [`=COUNTA('каждый звонок'!$A$3:$A$${callEnd})`],
  [`=COUNTIF('каждый звонок'!$E$3:$E$${callEnd},"Новый заказ")`],
  [`=COUNTIF('каждый звонок'!$E$3:$E$${callEnd},"Уточнение существующего заказа")`],
  [`=COUNTIF('каждый звонок'!$E$3:$E$${callEnd},"Спам / нецелевой звонок")`],
  [`=IFERROR(AVERAGE('каждый звонок'!$AA$3:$AA$${callEnd}),"")`],
  [`=COUNTIFS('каждый звонок'!$AA$3:$AA$${callEnd},"<=0.4",'каждый звонок'!$Z$3:$Z$${callEnd},">=35",'каждый звонок'!$E$3:$E$${callEnd},"<>Внутренний / служебный звонок",'каждый звонок'!$E$3:$E$${callEnd},"<>Спам / нецелевой звонок",'каждый звонок'!$E$3:$E$${callEnd},"<>Короткий / пропущенный звонок")`],
  [`=COUNTIFS('каждый звонок'!$X$3:$X$${callEnd},"<>")`],
  [`=COUNTIF('каждый звонок'!$H$3:$H$${callEnd},"Нет")`],
  [`=COUNTIF('каждый звонок'!$S$3:$S$${callEnd},"Нет")`],
];
summarySheet.getRange("E4:E10").formulas = [
  ...["Новый заказ", "Уточнение существующего заказа", "Консультация без явного заказа", "Внутренний / служебный звонок", "Спам / нецелевой звонок", "Короткий / пропущенный звонок", "Неясно"].map((category, index) => [`=COUNTIF('каждый звонок'!$E$3:$E$${callEnd},D${index + 4})`]),
];
summarySheet.getRange("F4").formulas = [[`=IFERROR(E4/$B$4,0)`]];
summarySheet.getRange("F4:F10").fillDown();
const summaryStatusValues = summaryDefinitions.map((definition) => calls.map((call) => {
  if (definition.key === "alternative_or_additional") return combineStatuses(status(call.analysis, "offered_alternative"), status(call.analysis, "offered_additional_products_services"));
  return status(call.analysis, definition.key);
}));
summaryStatusValues.forEach((values, index) => {
  const row = index + 16;
  const column = metricDefinitions[index].column;
  const statusRange = `'каждый звонок'!$${column}$3:$${column}$${callEnd}`;
  summarySheet.getRange(`B${row}:G${row}`).formulas = [[
    ...["Да", "Нет", "Частично", "Неясно", "Не применимо"].map((value) => `=COUNTIF(${statusRange},${formulaText(value)})`),
    `=IFERROR((B${row}+0.5*D${row})/(B${row}+C${row}+D${row}),"")`,
  ]];
});
summarySheet.getRange("A3:B3").format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, wrapText: true, borders: thinBorder };
summarySheet.getRange("D3:F3").format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, wrapText: true, borders: thinBorder };
summarySheet.getRange("A15:G15").format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", borders: thinBorder };
summarySheet.getRange("A4:B12").format = { borders: thinBorder };
summarySheet.getRange("D4:F10").format = { borders: thinBorder };
summarySheet.getRange("A16:G29").format = { borders: thinBorder, verticalAlignment: "center" };
summarySheet.getRange("B4:B12").format.horizontalAlignment = "center";
summarySheet.getRange("E4:F10").format.horizontalAlignment = "center";
summarySheet.getRange("B8:B8").format.numberFormat = "0%";
summarySheet.getRange("F4:F10").format.numberFormat = "0%";
summarySheet.getRange("G16:G29").format.numberFormat = "0%";
summarySheet.getRange("A1:A29").format.columnWidth = 49;
summarySheet.getRange("B1:B29").format.columnWidth = 18;
summarySheet.getRange("C1:C29").format.columnWidth = 4;
summarySheet.getRange("D1:D29").format.columnWidth = 34;
summarySheet.getRange("E1:F29").format.columnWidth = 14;
summarySheet.getRange("G1:G29").format.columnWidth = 13;
summarySheet.getRange("1:1").format.rowHeight = 28;
summarySheet.getRange("3:3").format.rowHeight = 32;
summarySheet.getRange("15:15").format.rowHeight = 28;
summarySheet.freezePanes.freezeRows(3);

const managerSheet = workbook.worksheets.getItem("менеджер средний показатель");
const managerEnd = managers.length + 2;
managerSheet.getRange("A1:V1").clear({ applyTo: "contents" });
managerSheet.getRange("A1").values = [["Средние показатели менеджеров"]];
managerSheet.getRange("A2:V2").values = [["№", "Менеджер", "Период", ...scoringCriteria.map((criterion) => criterion.label), "Вывод", "Рекомендация", "Упущения", "Красные флаги", "% выполнения"]];
managerSheet.getRange(`A3:V${managerEnd}`).clear({ applyTo: "contents" });
const managerRows = managers.map((manager, index) => {
  const subset = calls.filter((call) => call.manager === manager);
  const narrative = aggregateNarrative(subset);
  return [index + 1, manager, period, ...scoringCriteria.map(() => null), narrative.conclusion, narrative.recommendation, narrative.missed, narrative.flags, null];
});
managerSheet.getRange(`A3:V${managerEnd}`).values = managerRows;
metricDefinitions.forEach((definition, index) => {
  const col = String.fromCharCode("D".charCodeAt(0) + index);
  managerSheet.getRange(`${col}3:${col}${managerEnd}`).formulas = managers.map((_, rowIndex) => [managerMetricFormula(rowIndex + 3, definition.column, callEnd)]);
});
managerSheet.getRange("V3:V" + managerEnd).formulas = managers.map((_, index) => [`=IFERROR(AVERAGEIF('каждый звонок'!$B$3:$B$${callEnd},$B${index + 3},'каждый звонок'!$AA$3:$AA$${callEnd}),"")`]);
managerSheet.getRange("A1:V1").format = { fill: lightBlue, font: { bold: true, size: 13 }, verticalAlignment: "center" };
managerSheet.getRange("A2:V2").format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true, borders: thinBorder };
managerSheet.getRange(`A3:V${managerEnd}`).format = { wrapText: true, verticalAlignment: "top", borders: thinBorder };
managerSheet.getRange(`D3:Q${managerEnd}`).format = { horizontalAlignment: "center", numberFormat: "0%", borders: thinBorder };
managerSheet.getRange(`V3:V${managerEnd}`).format = { horizontalAlignment: "center", numberFormat: "0%", borders: thinBorder };
managerSheet.getRange(`A1:A${managerEnd}`).format.columnWidth = 7;
managerSheet.getRange(`B1:B${managerEnd}`).format.columnWidth = 37;
managerSheet.getRange(`C1:C${managerEnd}`).format.columnWidth = 22;
managerSheet.getRange(`D1:Q${managerEnd}`).format.columnWidth = 17;
managerSheet.getRange(`R1:S${managerEnd}`).format.columnWidth = 38;
managerSheet.getRange(`T1:U${managerEnd}`).format.columnWidth = 40;
managerSheet.getRange(`V1:V${managerEnd}`).format.columnWidth = 16;
managerSheet.getRange("1:1").format.rowHeight = 26;
managerSheet.getRange("2:2").format.rowHeight = 56;
managerSheet.getRange(`3:${managerEnd}`).format.rowHeight = 72;
managerSheet.freezePanes.freezeRows(2);
managerSheet.tables.add(`A2:V${managerEnd}`, true, "ManagersTable");

const departmentSheet = workbook.worksheets.getItem("средние показатели отдела");
const departmentEnd = departments.length + 2;
departmentSheet.getRange("A1:V1").clear({ applyTo: "contents" });
departmentSheet.getRange("A1").values = [["Средние показатели отделов продаж"]];
departmentSheet.getRange("A2:V2").values = [["№", "Отдел", "Период", ...scoringCriteria.map((criterion) => criterion.label), "Вывод", "Рекомендация", "Упущения", "Красные флаги", "% выполнения"]];
departmentSheet.getRange(`A3:V${departmentEnd}`).clear({ applyTo: "contents" });
departmentSheet.getRange(`A3:V${departmentEnd}`).values = departments.map((department, index) => {
  const subset = calls.filter((call) => call.departmentKey === department.key);
  const narrative = aggregateNarrative(subset);
  return [index + 1, department.name, period, ...scoringCriteria.map(() => null), narrative.conclusion, narrative.recommendation, narrative.missed, narrative.flags, null];
});
metricDefinitions.forEach((definition, index) => {
  const col = String.fromCharCode("D".charCodeAt(0) + index);
  departmentSheet.getRange(`${col}3:${col}${departmentEnd}`).formulas = departments.map((department) => [
    departmentMetricFormula(department.name, definition.column, callEnd),
  ]);
});
departmentSheet.getRange(`V3:V${departmentEnd}`).formulas = departments.map((department) => [
  departmentScoreFormula(department.name, callEnd),
]);
departmentSheet.getRange("A1:V1").format = { fill: lightBlue, font: { bold: true, size: 13 }, verticalAlignment: "center" };
departmentSheet.getRange("A2:V2").format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true, borders: thinBorder };
departmentSheet.getRange(`A3:V${departmentEnd}`).format = { wrapText: true, verticalAlignment: "top", borders: thinBorder };
departmentSheet.getRange(`D3:Q${departmentEnd}`).format = { horizontalAlignment: "center", numberFormat: "0%", borders: thinBorder };
departmentSheet.getRange(`V3:V${departmentEnd}`).format = { horizontalAlignment: "center", numberFormat: "0%", borders: thinBorder };
departmentSheet.getRange(`A1:A${departmentEnd}`).format.columnWidth = 7;
departmentSheet.getRange(`B1:B${departmentEnd}`).format.columnWidth = 27;
departmentSheet.getRange(`C1:C${departmentEnd}`).format.columnWidth = 22;
departmentSheet.getRange(`D1:Q${departmentEnd}`).format.columnWidth = 17;
departmentSheet.getRange(`R1:S${departmentEnd}`).format.columnWidth = 38;
departmentSheet.getRange(`T1:U${departmentEnd}`).format.columnWidth = 40;
departmentSheet.getRange(`V1:V${departmentEnd}`).format.columnWidth = 16;
departmentSheet.getRange("1:1").format.rowHeight = 26;
departmentSheet.getRange("2:2").format.rowHeight = 56;
departmentSheet.getRange(`3:${departmentEnd}`).format.rowHeight = 82;
departmentSheet.freezePanes.freezeRows(2);
departmentSheet.tables.add(`A2:V${departmentEnd}`, true, "DepartmentsTable");

const fillerSheet = workbook.worksheets.items.find((sheet) => sheet.name === "Слова-паразиты") || workbook.worksheets.add("Слова-паразиты");
for (const table of [...fillerSheet.tables.items]) table.delete();
fillerSheet.getRange("A1:F500").clear({ applyTo: "all" });
fillerSheet.getRange("A1:F2").unmerge();
const fillerRows = [];
for (const manager of managers) {
  const subset = calls.filter((call) => call.manager === manager);
  const phrases = aggregateFillerWords(subset);
  if (!phrases.length) {
    fillerRows.push([manager, "Не выявлены", 0, 0, subset.length, "В анализе звонков повторяющиеся слова-паразиты менеджера не выявлены"]);
    continue;
  }
  for (const row of phrases) {
    fillerRows.push([manager, row.phrase, row.occurrences, row.calls, subset.length, row.evidence.join("; ") || "Без надёжной короткой цитаты"]);
  }
}
const fillerEnd = fillerRows.length + 3;
fillerSheet.getRange("A1:F1").values = [["Слова-паразиты менеджеров", "", "", "", "", ""]];
fillerSheet.getRange("A2:F2").values = [["Учитываются только фразы, которые модель уверенно отнесла к речи менеджера и услышала не менее двух раз в одном звонке.", "", "", "", "", ""]];
fillerSheet.getRange("A1:F1").merge();
fillerSheet.getRange("A2:F2").merge();
fillerSheet.getRange("A3:F3").values = [["Менеджер", "Слово / фраза", "Повторений", "Звонков с фразой", "Всего звонков менеджера", "Примеры / комментарий"]];
fillerSheet.getRange(`A4:F${fillerEnd}`).values = fillerRows;
fillerSheet.getRange("A1:F1").format = { fill: lightBlue, font: { bold: true, size: 14 }, verticalAlignment: "center" };
fillerSheet.getRange("A2:F2").format = { wrapText: true, verticalAlignment: "center" };
fillerSheet.getRange("A3:F3").format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true, borders: thinBorder };
fillerSheet.getRange(`A4:F${fillerEnd}`).format = { wrapText: true, verticalAlignment: "top", borders: thinBorder };
fillerSheet.getRange(`C4:E${fillerEnd}`).format.horizontalAlignment = "center";
fillerSheet.getRange(`A1:A${fillerEnd}`).format.columnWidth = 37;
fillerSheet.getRange(`B1:B${fillerEnd}`).format.columnWidth = 25;
fillerSheet.getRange(`C1:E${fillerEnd}`).format.columnWidth = 18;
fillerSheet.getRange(`F1:F${fillerEnd}`).format.columnWidth = 62;
fillerSheet.getRange("1:1").format.rowHeight = 28;
fillerSheet.getRange("2:2").format.rowHeight = 38;
fillerSheet.getRange("3:3").format.rowHeight = 40;
fillerSheet.getRange(`4:${fillerEnd}`).format.rowHeight = 44;
fillerSheet.freezePanes.freezeRows(3);
fillerSheet.tables.add(`A3:F${fillerEnd}`, true, "FillerWordsTable");

const ranked = managers.map((manager) => {
  const subset = calls.filter((call) => call.manager === manager);
  const scores = subset.map((call) => call.visibleScore).filter((score) => Number.isFinite(score));
  const average = scores.length ? scores.reduce((total, score) => total + score, 0) / scores.length : null;
  return { manager, average, scoredCalls: scores.length };
}).filter((row) => row.scoredCalls > 0).sort((left, right) => right.average - left.average);
const rankingSheet = workbook.worksheets.getItem("рейтинг менеджеров");
rankingSheet.getRange("A1:D200").clear({ applyTo: "contents" });
rankingSheet.getRange("A1:D1").values = [["Рейтинг менеджеров", "", "", `Период: ${period}`]];
rankingSheet.getRange("A3:C3").values = [["Рейтинг", "ФИО", "Результат"]];
rankingSheet.getRange(`A4:C${ranked.length + 3}`).values = ranked.map((row, index) => [index + 1, row.manager, row.average]);
rankingSheet.getRange(`C4:C${ranked.length + 3}`).formulas = ranked.map((_, index) => [
  `=IFERROR(AVERAGEIF('каждый звонок'!$B$3:$B$${callEnd},$B${index + 4},'каждый звонок'!$AA$3:$AA$${callEnd}),"")`,
]);
rankingSheet.getRange("A1:D1").format = { fill: lightBlue, font: { bold: true, size: 13 }, verticalAlignment: "center" };
rankingSheet.getRange("A3:C3").format = { fill: blue, font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", borders: thinBorder };
rankingSheet.getRange(`A4:C${ranked.length + 3}`).format = { borders: thinBorder };
rankingSheet.getRange(`A4:A${ranked.length + 3}`).format.horizontalAlignment = "center";
rankingSheet.getRange(`C4:C${ranked.length + 3}`).format = { horizontalAlignment: "center", numberFormat: "0%", borders: thinBorder };
rankingSheet.getRange(`A1:A${ranked.length + 3}`).format.columnWidth = 12;
rankingSheet.getRange(`B1:B${ranked.length + 3}`).format.columnWidth = 31;
rankingSheet.getRange(`C1:C${ranked.length + 3}`).format.columnWidth = 16;
rankingSheet.getRange(`D1:D${ranked.length + 3}`).format.columnWidth = 36;
rankingSheet.getRange("1:1").format.rowHeight = 26;
rankingSheet.freezePanes.freezeRows(3);
rankingSheet.tables.add(`A3:C${ranked.length + 3}`, true, "RankingTable");

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });
const formulaErrors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" });
console.log(formulaErrors.ndjson);
const overview = await workbook.inspect({ kind: "workbook,sheet,table", maxChars: 5000, tableMaxRows: 6, tableMaxCols: 10 });
console.log(overview.ndjson);
for (const [sheetId, range] of [
  ["сводка", "A1:G29"],
  ["каждый звонок", `A1:${callsLastColumn}${Math.min(callEnd, 8)}`],
  ["менеджер средний показатель", `A1:V${Math.min(managerEnd, 8)}`],
  ["средние показатели отдела", `A1:V${departmentEnd}`],
  ["рейтинг менеджеров", `A1:D${Math.min(ranked.length + 3, 10)}`],
  ["Критерии оценки", `A1:G${criteriaLastRow}`],
  ["Слова-паразиты", `A1:F${Math.min(fillerEnd, 20)}`],
]) {
  const check = await workbook.inspect({
    kind: "table",
    sheetId,
    range,
    maxChars: 4500,
    tableMaxRows: 10,
    tableMaxCols: 30,
    tableMaxCellChars: 100,
  });
  console.log(check.ndjson);
}
const previewSpecs = [
  ["ТЗ", "A1:B29", 1.0],
  ["сводка", "A1:G29", 1.0],
  ["каждый звонок", `A1:${callsLastColumn}14`, 0.55],
  ["менеджер средний показатель", `A1:V${managerEnd}`, 0.65],
  ["средние показатели отдела", `A1:V${departmentEnd}`, 0.65],
  ["рейтинг менеджеров", `A1:D${ranked.length + 3}`, 1.0],
  ["Критерии оценки", `A1:G${criteriaLastRow}`, 0.85],
  ["Слова-паразиты", `A1:F${Math.min(fillerEnd, 20)}`, 0.9],
];
for (const [sheetName, range, scale] of previewSpecs) {
  const preview = await workbook.render({ sheetName, range, scale, format: "png" });
  await fs.writeFile(`${previewDir}/${sheetName}.png`, new Uint8Array(await preview.arrayBuffer()));
}
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({
  outputPath,
  calls: calls.length,
  managers,
  unmatchedHistory: unmatched,
  departmentAudit,
}));
