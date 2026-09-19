import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const configPath = process.argv[2] || "workbook_build/august_three_departments_report_config.json";
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const outputPath = `${config.outputDir}/${config.outputFile}`;
const expectedTotal = config.departments.reduce((sum, department) => sum + (department.expectedCalls ?? 200), 0);
const callEnd = expectedTotal + 2;
const includeUnauthorizedLegalEntity = config.departments.some(
  (department) => department.analysisSchemaVersion === "calls-strict-2.2",
);
const callsLastColumn = includeUnauthorizedLegalEntity ? "AF" : "AD";
const sourceInventory = config.sourceInventoryPath ? JSON.parse(await fs.readFile(config.sourceInventoryPath, "utf8")) : null;
const blob = await FileBlob.load(outputPath);
const workbook = await SpreadsheetFile.importXlsx(blob);

const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const text = (value) => String(value ?? "").trim();
const near = (left, right, epsilon = 1e-7) => Math.abs(Number(left) - Number(right)) <= epsilon;

const allAnalyses = [];
for (const department of config.departments) {
  const rows = (await fs.readFile(department.analysisPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const expected = department.expectedCalls ?? 200;
  assert(rows.length === expected, `${department.name}: ожидалось ${expected} анализов, найдено ${rows.length}`);
  assert(new Set(rows.map((row) => row.record?.file_name)).size === rows.length, `${department.name}: повторяющиеся файлы в анализах`);
  const sourceDepartment = sourceInventory?.departments.find((item) => item.key === department.key);
  for (const row of rows) {
    if (sourceDepartment) {
      const source = sourceDepartment.entries.find((entry) => entry.fileName === row.record?.file_name);
      assert(Boolean(source), `${department.name}: файл отсутствует в исходном наборе ${row.record?.file_name}`);
      if (source && row.record?.audio_sha256) assert(source.sha256 === row.record.audio_sha256, `${row.record.file_name}: хеш аудио изменился`);
    }
    assert(row.analysis?.schema_version === (department.analysisSchemaVersion || "calls-strict-2.1"), `${row.record?.file_name}: неверная версия анализа`);
    assert(!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{323af}]/u.test(JSON.stringify(row.analysis || {})), `${row.record?.file_name}: в анализе найден китайский текст`);
    allAnalyses.push({ department: department.name, ...row });
  }
}
assert(allAnalyses.length === expectedTotal, `Всего анализов: ${allAnalyses.length} вместо ${expectedTotal}`);

const callsSheet = workbook.worksheets.getItem("каждый звонок");
const callValues = callsSheet.getRange(`A3:${callsLastColumn}${callEnd}`).values;
const callFormulas = callsSheet.getRange(`Y3:AB${callEnd}`).formulas;
assert(callValues.length === expectedTotal, `В детализации ${callValues.length} строк вместо ${expectedTotal}`);
assert(callsSheet.getRange(`${callsLastColumn}${callEnd + 1}`).values[0][0] == null, "В детализации есть лишние строки");
assert(new Set(callValues.map((row) => row[29])).size === expectedTotal, "В детализации есть дубликаты или отсутствующие файлы");

const expectedStatuses = new Set(["Да", "Нет", "Частично", "Неясно", "Не применимо"]);
const expectedCategories = new Set([
  "Новый заказ",
  "Уточнение существующего заказа",
  "Консультация без явного заказа",
  "Внутренний / служебный звонок",
  "Спам / нецелевой звонок",
  "Короткий / пропущенный звонок",
  "Неясно",
]);
const analysisByFile = new Map(allAnalyses.map((row) => [row.record.file_name, row.analysis]));
const departmentCounts = Object.fromEntries(config.departments.map((department) => [department.name, 0]));
let internalCalls = 0;
let technicalAvitoCalls = 0;
let unauthorizedEntityOffers = 0;

for (let index = 0; index < callValues.length; index += 1) {
  const row = callValues[index];
  const excelRow = index + 3;
  const manager = text(row[1]);
  const category = text(row[4]);
  const fileName = text(row[29]);
  const analysis = analysisByFile.get(fileName);
  if (sourceInventory) {
    const sourceDepartment = sourceInventory.departments.find((department) => manager.endsWith(`(${department.name})`));
    const source = sourceDepartment?.entries.find((entry) => entry.fileName === fileName);
    assert(Boolean(source?.match), `Строка ${excelRow}: нет исходного сопоставления с историей`);
    if (source?.match) {
      assert(manager === `${source.match.manager} (${sourceDepartment.name})`, `Строка ${excelRow}: неверный менеджер ${manager}`);
      assert(!manager.startsWith("Не определён"), `Строка ${excelRow}: менеджер не определён`);
    }
  }
  assert(Boolean(analysis), `Строка ${excelRow}: не найден анализ ${fileName}`);
  assert(expectedCategories.has(category), `Строка ${excelRow}: неизвестная категория «${category}»`);
  for (let col = 6; col <= 19; col += 1) {
    assert(expectedStatuses.has(text(row[col])), `Строка ${excelRow}: неизвестный статус «${text(row[col])}»`);
  }
  for (const department of Object.keys(departmentCounts)) {
    if (manager.endsWith(`(${department})`)) departmentCounts[department] += 1;
  }
  if (/линия Авито/iu.test(manager)) technicalAvitoCalls += 1;

  for (let formulaCol = 0; formulaCol < 4; formulaCol += 1) {
    assert(text(callFormulas[index]?.[formulaCol]).startsWith("="), `Строка ${excelRow}: отсутствует формула ${["Y", "Z", "AA", "AB"][formulaCol]}`);
  }

  if (analysis) {
    assert(near(row[24], analysis.earned_points), `Строка ${excelRow}: набранные баллы не совпадают`);
    assert(near(row[25], analysis.applicable_points), `Строка ${excelRow}: применимые баллы не совпадают`);
    if (analysis.quality_percent == null) {
      assert(text(row[26]) === "", `Строка ${excelRow}: процент должен быть пустым`);
    } else {
      const expectedPercent = analysis.earned_points / analysis.applicable_points;
      assert(near(row[26], expectedPercent), `Строка ${excelRow}: процент не совпадает`);
    }
  }

  if (includeUnauthorizedLegalEntity) {
    const entityFlag = analysis?.red_flags?.unauthorized_legal_entity_offer;
    if (entityFlag?.status === "yes") {
      unauthorizedEntityOffers += 1;
      assert(text(row[30]) === text(entityFlag.detected_entity), `Строка ${excelRow}: не совпадает стороннее юрлицо`);
      assert(text(row[31]) === text(entityFlag.evidence), `Строка ${excelRow}: не совпадает подтверждающая фраза`);
    } else {
      assert(text(row[30]) === "" && text(row[31]) === "", `Строка ${excelRow}: стороннее юрлицо показано без подтверждённого флага`);
    }
  }

  if (category === "Внутренний / служебный звонок") {
    internalCalls += 1;
    assert(row.slice(6, 20).every((value) => text(value) === "Не применимо"), `Строка ${excelRow}: у внутреннего звонка есть применимые критерии`);
    assert(near(row[24], 0) && near(row[25], 0), `Строка ${excelRow}: у внутреннего звонка есть баллы`);
    assert(text(row[26]) === "", `Строка ${excelRow}: у внутреннего звонка есть процент`);
    assert(text(row[27]) === "Не оценивается", `Строка ${excelRow}: неверная расшифровка внутреннего звонка`);
    assert(text(row[23]) === "", `Строка ${excelRow}: у внутреннего звонка есть красный флаг`);
  }
}

for (const department of config.departments) {
  assert(departmentCounts[department.name] === (department.expectedCalls ?? 200), `${department.name}: неверное количество звонков ${departmentCounts[department.name]}`);
}

const criteriaValues = workbook.worksheets.getItem("Критерии оценки").getRange("A3:G30").values;
assert(Number(criteriaValues[2]?.[2]) === 3, "Вес вопроса об имени должен быть 3 балла");
assert(Number(criteriaValues[3]?.[2]) === 5, "Вес узнавания/использования имени должен быть 5 баллов");
assert(Number(criteriaValues[15]?.[2]) === 100, "Сумма весов должна быть 100 баллов");
if (includeUnauthorizedLegalEntity) {
  assert(criteriaValues.some((row) => text(row[0]) === "Разрешённые продавцы" && text(row[1]).includes("ООО «Железная-Мебель»") && text(row[1]).includes("ИП Алешина О.Ю.")), "Не указан список разрешённых юридических лиц");
} else {
  assert(!criteriaValues.some((row) => /Стороннее юридическое лицо|Разрешённые продавцы/u.test(text(row[0]))), "В отчёт попало московское правило юридических лиц");
}
const summaryValues = workbook.worksheets.getItem("сводка").getRange("A3:B12").values;
const expectedLowScores = callValues.filter((row) => typeof row[26] === "number" && row[26] <= 0.4).length;
assert(Number(summaryValues[6]?.[1]) === expectedLowScores, `Сводка: низких оценок ${summaryValues[6]?.[1]} вместо ${expectedLowScores}`);

const rankingValues = workbook.worksheets.getItem("рейтинг менеджеров").getUsedRange().values;
const rankedManagers = rankingValues.slice(3).map((row) => text(row[1])).filter(Boolean);
const scoredManagers = [...new Set(callValues.filter((row) => typeof row[26] === "number" && !text(row[1]).startsWith("Не определён")).map((row) => text(row[1])))];
assert(rankedManagers.length === scoredManagers.length, `В рейтинге ${rankedManagers.length} менеджеров вместо ${scoredManagers.length} оцениваемых`);
assert(scoredManagers.every((manager) => rankedManagers.includes(manager)), "В рейтинге пропущен оцениваемый менеджер");
assert(!rankedManagers.some((manager) => /авито|не определён/iu.test(manager)), "Техническая линия попала в рейтинг");
assert(rankedManagers.every((manager) => scoredManagers.includes(manager)), "Менеджер без оцениваемых звонков попал в рейтинг");
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
for (const row of rankingValues.slice(3).filter((row) => text(row[1]))) {
  const scores = callValues.filter((call) => text(call[1]) === text(row[1]) && typeof call[26] === "number").map((call) => call[26]);
  assert(near(row[2], average(scores), 0.0001), `Рейтинг ${row[1]}: средний процент неверен`);
}
for (const row of workbook.worksheets.getItem("менеджер средний показатель").getUsedRange().values.slice(2).filter((row) => text(row[1]))) {
  const scores = callValues.filter((call) => text(call[1]) === text(row[1]) && typeof call[26] === "number").map((call) => call[26]);
  assert(scores.length ? near(row[21], average(scores)) : text(row[21]) === "", `Менеджер ${row[1]}: внутренние/неоцениваемые звонки искажают среднее`);
}
for (const row of workbook.worksheets.getItem("средние показатели отдела").getUsedRange().values.slice(2).filter((row) => text(row[1]))) {
  const scores = callValues.filter((call) => text(call[1]).endsWith(`(${row[1]})`) && typeof call[26] === "number").map((call) => call[26]);
  assert(scores.length ? near(row[21], average(scores)) : text(row[21]) === "", `Отдел ${row[1]}: средний процент неверен`);
}

const fillerValues = workbook.worksheets.getItem("Слова-паразиты").getUsedRange().values;
const expectedManagers = [...new Set(callValues.map((row) => text(row[1])).filter((manager) => !manager.startsWith("Не определён")))];
assert(expectedManagers.every((manager) => fillerValues.some((row) => row.includes(manager))), "Лист слов-паразитов не содержит всех менеджеров");
assert(workbook.worksheets.items.length === 8, "В итоговой книге должно быть 8 листов");

const forbiddenCodes = new Set([
  "yes", "no", "partial", "unclear", "not_applicable", "new_order", "existing_order",
  "consultation_without_clear_order", "internal_operational", "spam_or_non_target", "missed_call_or_too_short",
]);
const formulaErrors = /#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A/u;
for (const sheet of workbook.worksheets.items) {
  for (const row of sheet.getUsedRange().values) {
    for (const value of row) {
      const cell = text(value);
      assert(!forbiddenCodes.has(cell), `${sheet.name}: найден английский код «${cell}»`);
      assert(!formulaErrors.test(cell), `${sheet.name}: найдена ошибка формулы «${cell}»`);
      assert(!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{323af}]/u.test(cell), `${sheet.name}: найден китайский текст «${cell.slice(0, 80)}»`);
    }
  }
}

let cardFlags = 0;
for (const item of allAnalyses) {
  const flag = item.analysis?.red_flags?.third_party_card_transfer;
  if (flag?.status !== "yes") continue;
  cardFlags += 1;
  const evidence = text(flag.evidence).toLowerCase().replaceAll("ё", "е");
  const organizationCard = /карт(?:а|очка)\s+(?:предприятия|организации)|реквизит(?:ы|ов)?\s+(?:компании|организации)/u.test(evidence);
  const payment = /перевест|оплат|деньг|рубл|сумм/u.test(evidence);
  const bankCard = /на\s+карт|номер\s+карт|личн\w*\s+карт|карт\w*\s+физ/u.test(evidence);
  assert(!organizationCard && payment && bankCard, `${item.record.file_name}: неподтверждённый флаг перевода на карту`);
}

const result = {
  outputPath,
  calls: callValues.length,
  analyses: allAnalyses.length,
  departmentCounts,
  technicalAvitoCalls,
  internalCalls,
  rankedManagers: rankedManagers.length,
  cardFlags,
  unauthorizedEntityOffers,
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 1;
