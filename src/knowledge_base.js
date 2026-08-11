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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(__dirname, "..", "knowledge", "instructions");

let INSTRUCTION_DOCS = [];

const STOPWORDS = new Set([
  "и", "в", "во", "на", "не", "что", "с", "со", "как", "по", "для", "из", "от", "за",
  "при", "или", "это", "то", "же", "бы", "а", "но", "к", "о", "об", "если", "до",
  "the", "a", "an", "of", "and", "or", "to", "in", "for", "with", "on", "at", "is",
  "1с", "бит", "1с.бит", "пользователя", "инструкция", "документ", "порядок", "формирование",
  "например", "также", "данные", "значения", "значение", "поля", "поле", "рисунок"
]);

function normalize(text) {
  return (text || "").toLowerCase();
}

function tokenize(text) {
  return normalize(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\p{L}\p{N}а-яё]+/gu, " ")
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
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

export function loadKnowledgeBase() {
  const docs = [];
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    console.warn(`Knowledge base directory not found: ${KNOWLEDGE_DIR}`);
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
      console.warn(`Cannot read ${full}: ${e.message}`);
      continue;
    }
    const header = parseHeader(content);
    const titleLine = content.split("\n").find(l => l.startsWith("# ")) || "";
    const title = titleLine.replace(/^#\s+/, "").trim();

    docs.push({
      id: file,
      file,
      code: header.code,
      source: header.source,
      type: header.type,
      title: title || file.replace(/\.md$/, ""),
      content,
      tokens: tokenize(content),
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
  const qTokens = tokenize(query);
  if (qTokens.length === 0) {
    return { query, total: 0, results: [] };
  }

  // Code exact match boost
  const results = [];
  for (const doc of INSTRUCTION_DOCS) {
    let score = 0;
    const matched = new Set();
    for (const tok of qTokens) {
      let hit = false;
      // title / code match counts more
      if (doc.title && normalize(doc.title).includes(tok)) { score += 5; hit = true; }
      if (doc.code && normalize(doc.code).includes(tok)) { score += 6; hit = true; }
      if (normalize(doc.content).includes(tok)) { score += 2; hit = true; }
      if (hit) matched.add(tok);
      // token frequency in body
      const freq = doc.tokens.filter(t => t === tok).length;
      score += Math.min(freq, 10) * 1.5;
    }
    if (matched.size > 0) {
      results.push({
        id: doc.id,
        code: doc.code,
        title: doc.title,
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

// Загружаем при старте
loadKnowledgeBase();
