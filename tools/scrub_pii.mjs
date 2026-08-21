#!/usr/bin/env node
/**
 * scrub_pii.mjs — обезличивание маршрутов согласования.
 *
 * Убирает из knowledge/routes/routes_db.json реальные ФИО сотрудников.
 * Маршрут должен описываться ролями и визами, а не конкретными людьми:
 * состав сотрудников меняется, а ПДн в файле базы знаний хранить нельзя.
 *
 * ФИО заменяются на «[ФИО удалено]» — структура и смысл шага сохраняются.
 *
 * Запуск: node tools/scrub_pii.mjs [--dry]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, "..", "knowledge", "routes", "routes_db.json");
const dry = process.argv.includes("--dry");

// Шаблоны ФИО:
//   «Иванов И.И.» / «Иванов И. И.» — фамилия с инициалами
//   «Иванова А.С» — инициалы без последней точки (встречается в данных)
//   склонения: «о решении Зырянова Д.А.»
const PATTERNS = [
  /[А-ЯЁ][а-яё]+(?:ов|ев|ин|ын|ский|цкий|ко|ук|юк|ач|ич|ей|ых|их|а|я)?\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.?/g,
];

const raw = fs.readFileSync(DB, "utf8");
const found = new Set();

let out = raw;
for (const re of PATTERNS) {
  out = out.replace(re, (m) => {
    // Не трогаем аббревиатуры вида «ООО А.Б.» и коды документов
    if (/^(ООО|АО|ЗАО|ПАО|ИП)\b/.test(m)) return m;
    found.add(m.trim());
    return "[ФИО удалено]";
  });
}

// Схлопываем перечисления: «[ФИО удалено], [ФИО удалено], ...» → одно упоминание
out = out.replace(/\[ФИО удалено\](?:[,/]\s*\\?n?\s*\[ФИО удалено\])+/g, "[ФИО удалены]");

console.log(`Найдено уникальных ФИО: ${found.size}`);
[...found].sort().forEach((f) => console.log(`  ${f}`));

if (dry) {
  console.log("\n--dry: файл не изменён");
} else {
  // Проверяем, что результат остался валидным JSON
  JSON.parse(out);
  fs.writeFileSync(DB, out, "utf8");
  const left = [...out.matchAll(/[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\./g)];
  console.log(`\nФайл обновлён. Остаточных совпадений: ${left.length}`);
}
