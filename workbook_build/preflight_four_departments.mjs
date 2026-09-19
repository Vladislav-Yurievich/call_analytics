import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { historyRecords, matchHistory, parseCallName } from "./strict_history_mapping.mjs";

const config = JSON.parse(await fs.readFile(process.argv[2] || "workbook_build/four_departments_report_config.json", "utf8"));
const inventory = { createdAt: new Date().toISOString(), departments: [] };
const failures = [];
for (const department of config.departments) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(department.historyPath));
  const records = historyRecords(workbook.worksheets.getItemAt(0).getUsedRange().values, department.managerOverrides);
  const files = (await fs.readdir(department.inputDir)).filter((name) => /\.mp3$/iu.test(name)).sort();
  if (files.length !== department.expectedCalls) failures.push(`${department.name}: incorrect MP3 count ${files.length}`);
  const entries = [];
  for (const fileName of files) {
    const metadata = parseCallName(fileName);
    const match = matchHistory(records, metadata);
    if (!match) failures.push(`${department.name}: no unique history match for ${fileName}`);
    const audio = await fs.readFile(path.join(department.inputDir, fileName));
    entries.push({ fileName, metadata, bytes: audio.length, sha256: createHash("sha256").update(audio).digest("hex"), match });
  }
  const managerCounts = {};
  for (const entry of entries) {
    const manager = entry.match?.manager || "UNMATCHED";
    managerCounts[manager] = (managerCounts[manager] || 0) + 1;
  }
  const historyHash = createHash("sha256").update(await fs.readFile(department.historyPath)).digest("hex");
  inventory.departments.push({ key: department.key, name: department.name, historyHash, managerCounts, entries });
  console.log(JSON.stringify({ department: department.name, calls: entries.length, managerCounts,
    maxTimeDifferenceSeconds: Math.max(...entries.map((entry) => (entry.match?.distance || 0) / 1000)) }, null, 2));
}
if (failures.length) throw new Error(failures.join("\n"));
await fs.writeFile(config.sourceInventoryPath, JSON.stringify(inventory, null, 2));
console.log(`All ${inventory.departments.reduce((sum, department) => sum + department.entries.length, 0)} MP3s uniquely matched to call history.`);
