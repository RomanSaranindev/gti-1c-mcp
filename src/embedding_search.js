/**
 * embedding_search.js — Семантический поиск на основе нейронных эмбеддингов
 *
 * Модель: Xenova/multilingual-e5-small (многоязычная, поддерживает русский)
 * Режим: офлайн, модель кэшируется в node_modules/.cache/xenova
 *
 * Инициализация ленивая: модель загружается при первом вызове buildEmbeddingIndex().
 * При неудаче (нет сети, недостаточно памяти) — возвращает is_ready=false,
 * и semantic_search_instructions автоматически падает назад на TF-IDF.
 */

// ─── Состояние ────────────────────────────────────────────────────────────────

/** @type {{ pipeline: Function, docEmbeddings: Map<string, Float32Array>, docs: Map<string, object> } | null} */
let embeddingIndex = null;

/** @type {boolean} */
let initInProgress = false;

/** @type {boolean} — false если модель не загрузилась (fallback на TF-IDF) */
let isReady = false;

/** @type {string | null} — сообщение об ошибке инициализации */
let initError = null;

// ─── Инициализация ────────────────────────────────────────────────────────────

/**
 * Загружает модель и вычисляет эмбеддинги для всех документов.
 * Идемпотентна: повторный вызов пересчитывает эмбеддинги для новых документов.
 *
 * @param {Array<{ id: string, title: string, content: string, code?: string, topic?: string, charCount?: number }>} docs
 * @returns {Promise<{ is_ready: boolean, docs_count: number, error?: string }>}
 */
export async function buildEmbeddingIndex(docs) {
  if (initInProgress) {
    return { is_ready: false, docs_count: 0, error: "Инициализация уже выполняется" };
  }
  if (!Array.isArray(docs) || docs.length === 0) {
    return { is_ready: false, docs_count: 0, error: "Пустой массив документов" };
  }

  initInProgress = true;

  try {
    process.stderr.write("🔄 [embedding_search] Загружаю модель multilingual-e5-small...\n");

    // Динамический импорт — @xenova/transformers — не блокирует старт сервера
    const { pipeline, env } = await import("@xenova/transformers");

    // Разрешаем использование кэша, запрещаем скачивание если кэш пуст
    // Модель весит ~120MB — скачается при первом запуске
    env.allowRemoteModels = true;
    env.allowLocalModels  = true;

    const extractor = await pipeline(
      "feature-extraction",
      "Xenova/multilingual-e5-small",
      { quantized: true } // ONNX quantized — меньше памяти
    );

    process.stderr.write("✅ [embedding_search] Модель загружена. Вычисляю эмбеддинги...\n");

    const docEmbeddingsMap = new Map();
    const docsMap = new Map();

    // Вычисляем эмбеддинги батчами по 8 документов
    const BATCH_SIZE = 8;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);

      // Для retrieval e5 модели нужен префикс "passage: " для документов
      const texts = batch.map((doc) =>
        `passage: ${doc.title || ""} ${(doc.content || "").slice(0, 512)}`
      );

      const output = await extractor(texts, { pooling: "mean", normalize: true });

      for (let j = 0; j < batch.length; j++) {
        const doc = batch[j];
        // output.data — Float32Array длиной batch_size * embedding_dim
        // Нарезаем вектор для каждого документа
        const dim = output.dims[output.dims.length - 1];
        const start = j * dim;
        const vec = new Float32Array(output.data.slice(start, start + dim));
        docEmbeddingsMap.set(doc.id, vec);
        docsMap.set(doc.id, doc);
      }

      process.stderr.write(`  [embedding_search] ${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length} документов обработано\n`);
    }

    embeddingIndex = {
      pipeline: extractor,
      docEmbeddings: docEmbeddingsMap,
      docs: docsMap,
      builtAt: new Date(),
      dim: embeddingIndex?.dim || detectDim(docEmbeddingsMap),
    };

    isReady = true;
    initError = null;
    process.stderr.write(`✅ [embedding_search] Индекс построен: ${docs.length} документов, dim=${embeddingIndex.dim}\n`);

    return { is_ready: true, docs_count: docs.length };
  } catch (err) {
    isReady = false;
    initError = err.message;
    process.stderr.write(`⚠️  [embedding_search] Не удалось загрузить модель: ${err.message}\n`);
    process.stderr.write("    Semantic search будет использовать TF-IDF fallback.\n");
    return { is_ready: false, docs_count: 0, error: err.message };
  } finally {
    initInProgress = false;
  }
}

function detectDim(map) {
  for (const v of map.values()) return v.length;
  return 384;
}

// ─── Вспомогательные функции ──────────────────────────────────────────────────

/**
 * Косинусное сходство двух нормализованных Float32Array.
 * Если векторы нормализованы — достаточно dot product.
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot; // Вектора нормализованы → dot == cosine
}

// ─── Поиск ────────────────────────────────────────────────────────────────────

/**
 * Выполняет семантический поиск по индексу эмбеддингов.
 *
 * @param {string} query — поисковый запрос на естественном языке
 * @param {{ limit?: number, minScore?: number }} [options]
 * @returns {Promise<{
 *   is_embedding: true,
 *   query: string,
 *   total: number,
 *   results: Array<{ id, code, title, topic, score, charCount }>
 * } | null>}
 *
 * Возвращает null если индекс не готов → вызывающий код переходит на TF-IDF.
 */
export async function embeddingSearch(query, { limit = 5, minScore = 0.3 } = {}) {
  if (!isReady || !embeddingIndex) {
    return null; // Fallback на TF-IDF
  }

  try {
    // Для retrieval e5 модели запрос получает префикс "query: "
    const queryText = `query: ${query}`;
    const output = await embeddingIndex.pipeline(queryText, { pooling: "mean", normalize: true });
    const queryVec = new Float32Array(output.data);

    const scored = [];
    for (const [id, docVec] of embeddingIndex.docEmbeddings) {
      const score = cosineSimilarity(queryVec, docVec);
      if (score >= minScore) {
        const doc = embeddingIndex.docs.get(id);
        scored.push({
          id,
          code:      doc?.code      || "",
          title:     doc?.title     || "",
          topic:     doc?.topic     || null,
          score:     Math.round(score * 10000) / 10000,
          charCount: doc?.charCount || 0,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return {
      is_embedding: true,
      query,
      total: scored.length,
      results: scored.slice(0, limit),
    };
  } catch (err) {
    process.stderr.write(`❌ [embedding_search] Ошибка при поиске: ${err.message}\n`);
    return null; // Fallback на TF-IDF
  }
}

// ─── Статус ───────────────────────────────────────────────────────────────────

/**
 * Возвращает статус embedding-индекса.
 */
export function getEmbeddingStats() {
  return {
    is_ready:     isReady,
    init_error:   initError,
    docs_count:   embeddingIndex?.docEmbeddings?.size || 0,
    dim:          embeddingIndex?.dim || null,
    built_at:     embeddingIndex?.builtAt?.toISOString() || null,
    model:        "Xenova/multilingual-e5-small",
  };
}
