/**
 * auth.js — персональные токены доступа с ролями.
 *
 * Заменяет единый общий MCP_API_TOKEN. Каждый пользователь получает свой токен,
 * привязанный к доменному логину 1С и роли (user | analyst | admin).
 *
 * Зачем это нужно:
 *   1. Аудит — видно кто именно выполнил запрос, а не «кто-то со знанием токена»
 *   2. Отзыв доступа — уволенному сотруднику отзывается его токен, остальные работают
 *   3. Разграничение — набор инструментов зависит от роли (см. TOOL_ACCESS в server.js)
 *   4. Делегирование identity — запросы к 1С идут под доменной учёткой пользователя,
 *      поэтому RLS и права базы применяются к нему, а не к общему техпользователю
 *
 * Хранилище: tokens.json (в .gitignore). Сам токен не хранится — только SHA-256 хеш,
 * как пароль. Утечка файла не даёт возможности подключиться.
 *
 * Формат записи:
 *   {
 *     "id":            "tok_a1b2c3d4",         — публичный идентификатор для логов
 *     "token_hash":    "<sha256 hex>",
 *     "login":         "HG\\ИвановИИ",         — доменный логин для Basic-auth в 1С
 *     "password_enc":  "<aes-256-gcm base64>", — пароль 1С, шифрован MCP_SECRET_KEY
 *     "role":          "user" | "analyst" | "admin",
 *     "comment":       "Иванов, бухгалтерия",
 *     "created_at":    "2026-08-21T09:00:00.000Z",
 *     "expires_at":    "2027-08-21T09:00:00.000Z" | null,
 *     "revoked":       false,
 *     "last_used_at":  "2026-08-21T10:15:00.000Z" | null
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TOKENS_PATH = process.env.MCP_TOKENS_FILE
  || path.join(__dirname, "..", "tokens.json");

/**
 * Роли в порядке возрастания привилегий.
 *
 *   user    — рядовой сотрудник: только инструкции (база знаний) и самодиагностика
 *             собственных прав на документ. К данным живой базы доступа нет.
 *   analyst — аналитик: все инструменты, кроме execute_1c_query. Работает через
 *             специализированные инструменты, где выборка полей контролируется кодом.
 *   admin   — плюс execute_1c_query (произвольный запрос), /reload и /status.
 */
export const ROLES = ["user", "analyst", "admin"];

/** Русские названия ролей для сообщений пользователю. */
export const ROLE_LABELS = {
  user: "Пользователь",
  analyst: "Аналитик",
  admin: "Администратор",
};

/**
 * Числовой ранг роли для сравнения «не ниже чем».
 * Неизвестная роль получает -1 и не проходит ни одну проверку (fail-closed).
 *
 * @param {string} role
 * @returns {number}
 */
export function roleRank(role) {
  return ROLES.indexOf(role);
}

/**
 * Проверяет, что роль не ниже требуемой.
 *
 * @param {string} role — роль из записи токена
 * @param {string} required — минимально необходимая роль
 * @returns {boolean}
 */
export function roleAtLeast(role, required) {
  const have = roleRank(role);
  const need = roleRank(required);
  // Неизвестная роль в токене или в требовании — отказ
  return have >= 0 && need >= 0 && have >= need;
}

// ── Шифрование паролей 1С ─────────────────────────────────────────────────────
//
// Пароли доменных учёток нельзя хранить в открытом виде: файл tokens.json
// читается процессом сервера и попадает в бэкапы. Используем AES-256-GCM —
// он даёт и шифрование, и проверку целостности (authTag), поэтому подменить
// зашифрованное значение снаружи не получится.

const ALGO = "aes-256-gcm";

/**
 * Выводит 32-байтовый ключ шифрования из MCP_SECRET_KEY.
 * @returns {Buffer}
 * @throws {Error} если переменная не задана
 */
function secretKey() {
  const raw = process.env.MCP_SECRET_KEY;
  if (!raw || raw.length < 16) {
    throw new Error(
      "MCP_SECRET_KEY не задан или короче 16 символов. " +
      "Сгенерируйте: node tools/token.mjs genkey"
    );
  }
  // scrypt приводит произвольную строку к ключу нужной длины
  return crypto.scryptSync(raw, "gti-1c-mcp-token-store", 32);
}

/**
 * Шифрует пароль 1С для хранения в tokens.json.
 * @param {string} plain
 * @returns {string} base64 от iv|authTag|ciphertext
 */
export function encryptPassword(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

/**
 * Расшифровывает пароль 1С.
 * @param {string} packed — результат encryptPassword
 * @returns {string}
 */
export function decryptPassword(packed) {
  const buf = Buffer.from(packed, "base64");
  const decipher = crypto.createDecipheriv(ALGO, secretKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return decipher.update(buf.subarray(28), undefined, "utf8") + decipher.final("utf8");
}

// ── Хранилище ─────────────────────────────────────────────────────────────────

/**
 * Читает реестр токенов с диска.
 * Отсутствие файла — не ошибка: сервер стартует, но никого не пускает.
 *
 * @returns {{ tokens: Array<object> }}
 */
export function loadTokens() {
  try {
    const raw = fs.readFileSync(TOKENS_PATH, "utf8");
    const data = JSON.parse(raw);
    return { tokens: Array.isArray(data.tokens) ? data.tokens : [] };
  } catch (err) {
    if (err.code === "ENOENT") return { tokens: [] };
    throw new Error(`Не удалось прочитать ${TOKENS_PATH}: ${err.message}`);
  }
}

/**
 * Записывает реестр токенов на диск с правами 0600 (только владелец).
 * @param {{ tokens: Array<object> }} store
 */
export function saveTokens(store) {
  const json = JSON.stringify(store, null, 2);
  fs.writeFileSync(TOKENS_PATH, json, { encoding: "utf8", mode: 0o600 });
  // На случай, если файл существовал с более широкими правами
  try { fs.chmodSync(TOKENS_PATH, 0o600); } catch { /* Windows — игнорируем */ }
}

// ── Генерация и проверка ──────────────────────────────────────────────────────

/** Хеширует токен для хранения. */
export function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Генерирует новый токен.
 * Префикс gti_ помогает секрет-сканерам (gitleaks, GitHub secret scanning)
 * распознать строку как учётные данные, если она случайно попадёт в коммит.
 *
 * @returns {string}
 */
export function generateToken() {
  return "gti_" + crypto.randomBytes(24).toString("base64url");
}

/**
 * Сравнение хешей за постоянное время.
 * Обычное !== завершается на первом различающемся байте, и по времени ответа
 * можно побайтово подобрать токен.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Проверяет предъявленный токен.
 *
 * @param {string} presented — значение заголовка X-MCP-Token
 * @returns {{ ok: true, entry: object } | { ok: false, reason: string }}
 */
export function verifyToken(presented) {
  if (!presented || typeof presented !== "string") {
    return { ok: false, reason: "Токен не предъявлен" };
  }

  const hash = hashToken(presented);
  const { tokens } = loadTokens();

  // Перебираем все записи, а не выходим на первом совпадении по префиксу —
  // сравнение идёт по полному хешу за постоянное время.
  const entry = tokens.find((t) => safeEqual(t.token_hash || "", hash));
  if (!entry) return { ok: false, reason: "Неизвестный токен" };
  if (entry.revoked) return { ok: false, reason: "Токен отозван" };

  if (entry.expires_at && new Date(entry.expires_at) < new Date()) {
    return { ok: false, reason: "Срок действия токена истёк" };
  }

  return { ok: true, entry };
}

/**
 * Отмечает факт использования токена (для отчёта о неактивных учётках).
 * Запись «раз в час» — чтобы не писать файл на каждый запрос.
 *
 * @param {string} id — публичный идентификатор записи
 */
const lastTouch = new Map();
export function touchToken(id) {
  const now = Date.now();
  if (now - (lastTouch.get(id) || 0) < 3_600_000) return;
  lastTouch.set(id, now);
  try {
    const store = loadTokens();
    const entry = store.tokens.find((t) => t.id === id);
    if (entry) {
      entry.last_used_at = new Date().toISOString();
      saveTokens(store);
    }
  } catch { /* обновление статистики не должно ронять запрос */ }
}

/**
 * Возвращает учётные данные 1С для записи токена.
 * Если у записи нет своих — откатываемся на общие ONEC_* из .env
 * (режим совместимости: сервер работает как раньше, под техпользователем).
 *
 * @param {object} entry
 * @returns {{ username: string, password: string, delegated: boolean }}
 */
export function credentialsFor(entry) {
  if (entry?.login && entry?.password_enc) {
    return {
      username: entry.login,
      password: decryptPassword(entry.password_enc),
      delegated: true,
    };
  }
  return {
    username: process.env.ONEC_USERNAME || "",
    password: process.env.ONEC_PASSWORD || "",
    delegated: false,
  };
}
