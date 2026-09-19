const digits = (value) => String(value ?? "").replace(/\D/gu, "");
const managerName = (value) => String(value ?? "").replace(/\s*\([^)]*\)\s*$/u, "").trim();

export function parseCallName(fileName) {
  const match = fileName.match(/^(\d+)_(in|out)_(\d+)_(\d{4})_(\d{2})_(\d{2})-(\d{2})_(\d{2})_(\d{2})_([^.]+)\.mp3$/iu);
  if (!match) throw new Error(`Unrecognized call filename: ${fileName}`);
  return {
    source_number: match[1], direction: match[2], target_number: match[3],
    call_datetime: `${match[4]}-${match[5]}-${match[6]} ${match[7]}:${match[8]}:${match[9]}`,
    call_id: match[10],
  };
}

export function historyRecords(rows, overrides = {}) {
  const headerIndex = rows.findIndex((row) => row[1] === "Клиент" && row[2] === "Сотрудник");
  if (headerIndex < 0) throw new Error("Call history header not found");
  const header = rows[headerIndex];
  const compactFormat = header[5] === "Дата" && header[6] === "Время";
  return rows.slice(headerIndex + 1).map((row, index) => {
    const forwarding = compactFormat ? digits(row[4]) : digits(row[6]);
    const manager = overrides[forwarding] || managerName(row[2]);
    const dateColumn = compactFormat ? 5 : 7;
    const timeColumn = compactFormat ? 6 : 8;
    const timestamp = Math.round((Number(row[dateColumn]) + Number(row[timeColumn]) - 25569) * 86400000);
    return { client: digits(row[1]), manager, forwarding, through: compactFormat ? "" : digits(row[4]),
      timestamp, historyRow: headerIndex + index + 2, rawManager: row[2] || "" };
  }).filter((row) => row.client && Number.isFinite(row.timestamp));
}

export function matchHistory(records, metadata) {
  const source = digits(metadata.source_number);
  const target = digits(metadata.target_number);
  const timestamp = Date.parse(metadata.call_datetime.replace(" ", "T") + "Z");
  // Call recordings and PBX exports have historically differed by two hours.
  const candidates = records.filter((row) => row.client === source).map((row) => ({
    ...row,
    distance: Math.min(...[0, -7200000, 7200000].map((offset) => Math.abs(row.timestamp - timestamp - offset))),
  })).filter((row) => row.distance <= 120000).sort((a, b) => a.distance - b.distance);
  if (!candidates.length) return null;
  if (candidates.every((row) => !row.forwarding && !row.through)) {
    const nearest = candidates.filter((row) => row.distance === candidates[0].distance);
    const managers = new Set(nearest.map((row) => row.manager).filter(Boolean));
    if (managers.size !== 1) return null;
    return { ...nearest[0], method: "client_datetime_direct_employee" };
  }
  const compatibleCandidates = candidates.filter((row) => row.forwarding === target || row.through === target);
  const pool = compatibleCandidates.length ? compatibleCandidates : candidates;
  const nearest = pool.filter((row) => row.distance === pool[0].distance);
  const exactLine = nearest.filter((row) => row.forwarding === target);
  const compatible = exactLine.length ? exactLine : nearest.filter((row) => row.through === target);
  const finalists = compatible.length ? compatible : nearest;
  const identities = new Set(finalists.map((row) => `${row.manager}|${row.forwarding}`));
  if (identities.size !== 1) return null;
  if (!compatibleCandidates.length) {
    const directLineRows = records.filter((row) => row.forwarding === target && row.manager);
    const directManagers = [...new Set(directLineRows.map((row) => row.manager))];
    if (directManagers.length !== 1) return null;
    // A transferred call can have separate recordings for the original and final extension.
    return { ...finalists[0], manager: directManagers[0], method: "direct_extension_for_transfer",
      managerHistoryRows: directLineRows.map((row) => row.historyRow), recordingExtension: target };
  }
  return { ...finalists[0], method: "client_datetime_forwarding",
    manager: finalists[0].manager || `Не определён (номер ${finalists[0].forwarding})` };
}
