import test from "node:test";
import assert from "node:assert/strict";
import { historyRecords, matchHistory, parseCallName } from "./strict_history_mapping.mjs";

const metadata = parseCallName("79000000000_in_79200000001_2026_08_28-09_48_18_id.mp3");
const timestamp = Date.parse("2026-08-28T09:48:18Z");
const first = { client: "79000000000", manager: "Manager A", forwarding: "79200000001",
  through: "78000000000", timestamp, historyRow: 13 };

test("exact direct line and a two-hour export offset", () => {
  const result = matchHistory([{ ...first, timestamp: timestamp + 7200000 }], metadata);
  assert.equal(result.manager, "Manager A");
  assert.equal(result.distance, 0);
});

test("a closer row on another extension must not win", () => {
  const wrong = { ...first, manager: "Manager B", forwarding: "79200000002" };
  const right = { ...first, timestamp: timestamp + 1000 };
  assert.equal(matchHistory([wrong, right], metadata).manager, "Manager A");
});

test("transfer recording uses its own uniquely identified extension", () => {
  const event = { ...first, manager: "Manager B", forwarding: "79200000002" };
  const reference = { ...first, client: "79000000005", historyRow: 14 };
  const result = matchHistory([event, reference], metadata);
  assert.equal(result.manager, "Manager A");
  assert.equal(result.method, "direct_extension_for_transfer");
});

test("ambiguous call and missing source stay unresolved", () => {
  assert.equal(matchHistory([first, { ...first, manager: "Manager B" }], metadata), null);
  assert.equal(matchHistory([], metadata), null);
});

test("unnamed extension remains explicit rather than borrowed", () => {
  const result = matchHistory([{ ...first, manager: "" }], metadata);
  assert.ok(result.manager.includes(first.forwarding));
});

test("malformed recording names are rejected", () => {
  assert.throws(() => parseCallName("random.mp3"));
});

test("compact Kyrgyzstan history maps by client, time and employee", () => {
  const serial = timestamp / 86400000 + 25569;
  const dateSerial = Math.floor(serial);
  const timeSerial = serial - dateSerial;
  const rows = [
    ["Тип звонка", "Клиент", "Сотрудник", "Должность", "Переадресация", "Дата", "Время"],
    ["входящий", "79000000000", "Manager K", "Менеджер", null, dateSerial, timeSerial],
  ];
  const records = historyRecords(rows);
  const result = matchHistory(records, metadata);
  assert.equal(result.manager, "Manager K");
  assert.equal(result.method, "client_datetime_direct_employee");
});
