/**
 * Модуль векторного поиска по инструкциям 1С
 * Алгоритм: TF-IDF + cosine similarity + морфологический стеммер
 * Работает полностью офлайн, без ML-зависимостей
 */

import { STOPWORDS } from "./stopwords.js";
import { stemTokenize } from "./stemmer.js";

// ─── Токенизация с морфологическим стеммингом ─────────────────────────────────

/**
 * Токенизирует строку с применением стеммера и единого списка стоп-слов.
 * Синхронизирован с knowledge_base.js — используют одни и те же правила.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  return stemTokenize(text, STOPWORDS);
}

// ─── Состояние индекса ────────────────────────────────────────────────────────

/** @type {{ vocab: Map, docVectors: Map, docs: Map, builtAt: Date } | null} */
export let tfidfIndex = null;

// ─── buildTfidfIndex ──────────────────────────────────────────────────────────

/**
 * Строит TF-IDF индекс по массиву документов.
 *
 * @param {Array<{ id: string, code: string, title: string, content: string,
 *                 tokens: string[], charCount: number, source: string, type: string }>} docs
 * @returns {{ vocab: Map<string, number>, docVectors: Map<string, Object>,
 *             docs: Map<string, Object>, builtAt: Date }}
 */
export function buildTfidfIndex(docs) {
  if (!Array.isArray(docs) || docs.length === 0) {
    throw new Error("buildTfidfIndex: docs должен быть непустым массивом");
  }

  const N = docs.length;

  // ── 1. Подсчёт DF (document frequency) для каждого термина ──────────────
  /** @type {Map<string, number>} term → кол-во документов */
  const df = new Map();

  /** @type {Map<string, { tokens: string[], total: number }>} */
  const docTokens = new Map();

  for (const doc of docs) {
    // Используем уже токенизированный массив, если есть; иначе токенизируем сами
    const tokens = Array.isArray(doc.tokens) && doc.tokens.length > 0
      ? doc.tokens
      : tokenize((doc.content || "") + " " + (doc.title || ""));

    docTokens.set(doc.id, { tokens, total: tokens.length });

    // Уникальные термины в документе → обновляем DF
    const unique = new Set(tokens);
    for (const term of unique) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  // ── 2. Словарь (vocab): term → IDF ──────────────────────────────────────
  /** @type {Map<string, number>} */
  const vocab = new Map();

  for (const [term, docFreq] of df) {
    const idf = Math.log(N / (docFreq + 1));
    vocab.set(term, idf);
  }

  // ── 3. TF-IDF векторы документов ────────────────────────────────────────
  /** @type {Map<string, Object>} doc.id → { term: tfidf_score } */
  const docVectors = new Map();

  for (const doc of docs) {
    const { tokens, total } = docTokens.get(doc.id);
    if (total === 0) {
      docVectors.set(doc.id, {});
      continue;
    }

    // TF: частота термина в документе
    const tf = new Map();
    for (const term of tokens) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    // TF-IDF вектор
    const vector = {};
    for (const [term, count] of tf) {
      const idf = vocab.get(term) || 0;
      vector[term] = (count / total) * idf;
    }

    docVectors.set(doc.id, vector);
  }

  // ── 4. Индекс документов ────────────────────────────────────────────────
  /** @type {Map<string, Object>} */
  const docsMap = new Map();
  for (const doc of docs) {
    docsMap.set(doc.id, doc);
  }

  // ── 5. Сохранить и вернуть ──────────────────────────────────────────────
  tfidfIndex = {
    vocab,
    docVectors,
    docs: docsMap,
    builtAt: new Date()
  };

  return tfidfIndex;
}

// ─── Вспомогательные функции ──────────────────────────────────────────────────

/**
 * Косинусное сходство двух разреженных векторов (объекты {term: score}).
 * @param {Object} vecA
 * @param {Object} vecB
 * @returns {number}
 */
function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, scoreA] of Object.entries(vecA)) {
    normA += scoreA * scoreA;
    if (vecB[term] !== undefined) {
      dot += scoreA * vecB[term];
    }
  }

  for (const scoreB of Object.values(vecB)) {
    normB += scoreB * scoreB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── tfidfSearch ──────────────────────────────────────────────────────────────

/**
 * Поиск документов по текстовому запросу.
 *
 * @param {string} query — поисковый запрос
 * @param {{ limit?: number, minScore?: number }} [options]
 * @returns {{ query: string, total: number,
 *             results: Array<{ id, code, title, score, matched_terms, charCount }> }}
 */
export function tfidfSearch(query, { limit = 5, minScore = 0.01 } = {}) {
  if (!tfidfIndex) {
    throw new Error("tfidfSearch: индекс не построен. Вызовите buildTfidfIndex() сначала.");
  }

  const { vocab, docVectors, docs } = tfidfIndex;

  // ── 1. Токенизация запроса ───────────────────────────────────────────────
  const queryTokens = tokenize(query);
  const queryLower = query.toLowerCase();

  if (queryTokens.length === 0) {
    return { query, total: 0, results: [] };
  }

  // ── 2. TF-IDF вектор запроса ─────────────────────────────────────────────
  const qtf = new Map();
  for (const term of queryTokens) {
    qtf.set(term, (qtf.get(term) || 0) + 1);
  }

  const queryVector = {};
  for (const [term, count] of qtf) {
    const idf = vocab.get(term) || 0;
    queryVector[term] = (count / queryTokens.length) * idf;
  }

  // ── 3. Вычислить сходство с каждым документом ────────────────────────────
  const scored = [];

  for (const [id, docVec] of docVectors) {
    const doc = docs.get(id);
    if (!doc) continue;

    let score = cosineSimilarity(queryVector, docVec);

    // ── 4. Бонусы ────────────────────────────────────────────────────────
    const titleLower = (doc.title || "").toLowerCase();
    const codeLower  = (doc.code  || "").toLowerCase();

    // +0.3 если запрос содержится в title
    if (titleLower.includes(queryLower)) {
      score += 0.3;
    }

    // +0.4 если запрос содержится в code (например "ИП-301")
    if (codeLower.includes(queryLower) || queryLower.includes(codeLower)) {
      score += 0.4;
    }

    // +0.15 за каждый токен запроса, найденный в заголовке
    for (const token of queryTokens) {
      if (titleLower.includes(token)) {
        score += 0.15;
      }
    }

    // Определить совпавшие термины
    const matched_terms = queryTokens.filter(t => docVec[t] !== undefined);

    if (score >= minScore) {
      scored.push({
        id,
        code:          doc.code      || "",
        title:         doc.title     || "",
        topic:         doc.topic     || null,
        score:         Math.round(score * 10000) / 10000,
        matched_terms,
        charCount:     doc.charCount || 0
      });
    }
  }

  // ── 5. Сортировка и обрезка ──────────────────────────────────────────────
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit);

  return {
    query,
    total: scored.length,
    results
  };
}

// ─── getIndexStats ────────────────────────────────────────────────────────────

/**
 * Возвращает статистику текущего индекса.
 * @returns {{ docs_count: number, vocab_size: number, built_at: string|null, ready: boolean }}
 */
export function getIndexStats() {
  if (!tfidfIndex) {
    return {
      docs_count: 0,
      vocab_size: 0,
      built_at:   null,
      ready:      false
    };
  }

  return {
    docs_count: tfidfIndex.docs.size,
    vocab_size: tfidfIndex.vocab.size,
    built_at:   tfidfIndex.builtAt.toISOString(),
    ready:      true
  };
}
