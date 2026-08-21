/**
 * Knowledge Base: Инструкции пользователя 1С.БИТ
 *
 * Загружает Markdown-инструкции из knowledge/instructions/ (конвертированы
 * из DOCX/PDF исходников в папке Instructions/) и предоставляет поиск по ним.
 *
 * Экспорт:
 *   INSTRUCTION_DOCS        - массив загруженных документов
 *   loadKnowledgeBase()     - (пере)загрузка из каталога
 *   listInstructions()      - сводка всех инструкций
 *   searchInstructions()    - полнотекстовый keyword-поиск
 *   getInstruction(id)      - полный текст инструкции по id
 *   findInstructionCode()   - поиск инструкции по коду (ИП-301 и т.п.)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STOPWORDS } from "./stopwords.js";
import { stemTokenize, stem } from "./stemmer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(__dirname, "..", "knowledge", "instructions");

let INSTRUCTION_DOCS = [];

function normalize(text) {
  return (text || "").toLowerCase();
}

/**
 * Токенизация с морфологическим стеммингом.
 * Использует единый список стоп-слов из stopwords.js и стеммер из stemmer.js.
 */
function tokenize(text) {
  return stemTokenize(text, STOPWORDS);
}

/**
 * Правила автоопределения раздела по имени файла и контенту.
 * Проверяются в порядке приоритета — первое совпадение побеждает.
 */
const TOPIC_RULES = [
  { topic: "Казначейство",       patterns: [/казначейств|казн|платёж|платеж|zayavka-rds|reestry-platezhej|prognoz-platezhej/i] },
  { topic: "Транспорт и ГСМ",    patterns: [/транспорт|путев|авто|gsm|диспетч|механик|avtotr|топлив|ГСМ/i] },
  { topic: "Склад и снабжение",  patterns: [/склад|снабжен|sklad|кладовщик|МПЗ|ордер|перемещен|инвентар|закупк/i] },
  { topic: "Бюджетирование",     patterns: [/бюджет|byudz|план-факт|финансовое планирование/i] },
  { topic: "Бухгалтерия",        patterns: [/бухгалтер|бух|проводк|НДС|налог|МСФО|авансовый отчет|buh/i] },
  { topic: "Закупки и договоры", patterns: [/закупк|договор|поставщик|заказ поставщик|ОМТС|МПЗ/i] },
  { topic: "Номенклатура и НСИ", patterns: [/номенклатур|nomen|нси|классификатор|НСИ/i] },
  { topic: "ЭДО",                patterns: [/эдо|электронный документ|vedo|подпис|ЭЦП/i] },
  { topic: "Методические",       patterns: [/метод|metod|инструкци|памятк|poryadok/i] },
  { topic: "Доступ и роли",      patterns: [/доступ|роль|ACL|группа пользователей|LUG|acl/i] },
];

/**
 * Определяет тематический раздел документа.
 * Приоритет: 1) явное поле "Раздел:" в тексте, 2) авто по имени файла + заголовку + первым 500 символам.
 *
 * @param {string} filename
 * @param {string} content
 * @returns {string|null}
 */
function detectTopic(filename, content) {
  // 1. Явное поле в тексте
  const sectionMatch = content.match(/Раздел:\s*(.+)/);
  if (sectionMatch) return sectionMatch[1].trim();

  // 2. Авто-детект по имени файла + заголовку + первым 500 символам
  const sample = (filename + " " + content.slice(0, 500)).toLowerCase();
  for (const rule of TOPIC_RULES) {
    if (rule.patterns.some((p) => p.test(sample))) {
      return rule.topic;
    }
  }
  return null;
}

function parseHeader(content) {
  const header = {};
  const codeMatch = content.match(/Код инструкции: `([^`]+)`/);
  const srcMatch = content.match(/Источник: `([^`]+)`/);
  const typeMatch = content.match(/Тип: ([A-Z.]+)/);
  header.code = codeMatch ? codeMatch[1].trim() : null;
  header.source = srcMatch ? srcMatch[1].trim() : null;
  header.type = typeMatch ? typeMatch[1].trim() : null;
  return header;
}

/**
 * Получает все уникальные разделы из загруженных инструкций.
 * @returns {string[]}
 */
export function listTopics() {
  const topics = new Set(INSTRUCTION_DOCS.map((d) => d.topic).filter(Boolean));
  return [...topics].sort();
}

/**
 * Возвращает все инструкции из заданного раздела (точное или частичное совпадение).
 * @param {string} topic
 * @returns {object[]}
 */
export function getInstructionsByTopic(topic) {
  const q = topic.toLowerCase();
  return INSTRUCTION_DOCS.filter(
    (d) => d.topic && d.topic.toLowerCase().includes(q)
  ).map((d) => ({
    id: d.id,
    code: d.code,
    title: d.title,
    topic: d.topic,
    source: d.source,
    charCount: d.charCount,
  }));
}

/** Возвращает загруженные документы без повторного чтения диска. */
export function getLoadedDocs() {
  return INSTRUCTION_DOCS;
}

export function loadKnowledgeBase() {
  const docs = [];
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    process.stderr.write(`⚠️  Knowledge base directory not found: ${KNOWLEDGE_DIR}\n`);
    INSTRUCTION_DOCS = [];
    return INSTRUCTION_DOCS;
  }

  const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.toLowerCase().endsWith(".md")).sort();

  for (const file of files) {
    const full = path.join(KNOWLEDGE_DIR, file);
    let content;
    try {
      content = fs.readFileSync(full, "utf-8");
    } catch (e) {
      process.stderr.write(`⚠️  Cannot read ${full}: ${e.message}\n`);
      continue;
    }
    const header = parseHeader(content);
    const titleLine = content.split("\n").find(l => l.startsWith("# ")) || "";
    const title = titleLine.replace(/^#\s+/, "").trim();
    const topic = detectTopic(file, content);

    const tokens = tokenize(content);

    // Частотный индекс токенов — строится ОДИН раз при загрузке.
    // Без него searchInstructions делал два полных прохода по массиву
    // на каждый токен запроса (includes + filter) — O(docs × qTokens × docTokens).
    const tokenFreq = new Map();
    for (const t of tokens) {
      tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
    }

    docs.push({
      id: file,
      file,
      code: header.code,
      source: header.source,
      type: header.type,
      title: title || file.replace(/\.md$/, ""),
      topic,
      content,
      tokens,
      tokenFreq,
      // Стеммы заголовка — тоже один раз, а не в двойном цикле поиска
      titleTokens: new Set(tokenize(title || file.replace(/\.md$/, ""))),
      // Нормализованный код для точного совпадения без повторной нормализации
      codeNorm: header.code ? normalize(header.code) : "",
      charCount: content.length
    });
  }

  INSTRUCTION_DOCS = docs;
  return INSTRUCTION_DOCS;
}

export function listInstructions() {
  return INSTRUCTION_DOCS.map(d => ({
    id: d.id,
    code: d.code,
    title: d.title,
    topic: d.topic,
    source: d.source,
    type: d.type,
    charCount: d.charCount
  }));
}

export function getInstruction(id) {
  const doc = INSTRUCTION_DOCS.find(d => d.id === id);
  if (doc) return doc;
  // tolerant match by code
  const code = String(id).toUpperCase().replace(/\s+/g, "").replace("-", "-");
  return INSTRUCTION_DOCS.find(d => d.code && d.code.toUpperCase().replace(/\s+/g, "") === code) || null;
}

export function findInstructionCode(code) {
  const norm = String(code).toUpperCase().replace(/\s+/g, "");
  return INSTRUCTION_DOCS.find(d => d.code && d.code.toUpperCase().replace(/\s+/g, "") === norm) || null;
}

export function searchInstructions(query, { limit = 5 } = {}) {
  // Токенизация с морфологическим стеммингом
  const qTokens = tokenize(query);
  // Также сохраняем оригинальные токены для совпадения по code
  const qRaw = normalize(query);

  if (qTokens.length === 0) {
    return { query, total: 0, results: [] };
  }

  const results = [];
  for (const doc of INSTRUCTION_DOCS) {
    let score = 0;
    const matched = new Set();

    for (const tok of qTokens) {
      let hit = false;

      // Совпадение в заголовке — Set.has() вместо tokenize() + includes()
      if (doc.titleTokens.has(tok)) { score += 5; hit = true; }

      // Совпадение в коде инструкции (без стеммера — точное)
      if (doc.codeNorm && doc.codeNorm.includes(tok)) { score += 6; hit = true; }

      // Частота токена в теле — Map.get() за O(1) вместо includes() + filter()
      const freq = doc.tokenFreq.get(tok) || 0;
      if (freq > 0) { score += 2; hit = true; }

      if (hit) matched.add(tok);

      score += Math.min(freq, 10) * 1.5;
    }

    if (matched.size > 0) {
      results.push({
        id: doc.id,
        code: doc.code,
        title: doc.title,
        topic: doc.topic,
        score: Math.round(score * 100) / 100,
        matched_tokens: [...matched],
        charCount: doc.charCount
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, limit);

  return {
    query,
    total: results.length,
    results: top
  };
}

// Примечание: loadKnowledgeBase() больше не вызывается при импорте модуля.
// Вызывается один раз из server.js после инициализации транспорта.
