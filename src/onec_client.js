/**
 * onec_client.js — HTTP-клиент для работы с 1С:Предприятие
 *
 * Транслирует вызовы инструментов MCP в JSON-RPC запросы к HTTP-сервису 1С,
 * опубликованному через расширение (build/MCP_Сервер.cfe от vladimir-kharin/1c_mcp).
 *
 * Протокол:
 *   POST {ONEC_URL}/hs/{ONEC_SERVICE_ROOT}/rpc
 *   Content-Type: application/json
 *   Authorization: Basic base64(username:password)
 *
 * Формат запроса:
 *   { "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "...", "arguments": {} } }
 *
 * Конфигурация через переменные окружения:
 *   ONEC_URL          — URL базы, например http://localhost/base (обязательно для работы)
 *   ONEC_USERNAME     — логин пользователя 1С
 *   ONEC_PASSWORD     — пароль пользователя 1С
 *   ONEC_SERVICE_ROOT — корень HTTP-сервиса (default: mcp)
 *   ONEC_TIMEOUT      — таймаут запроса в мс (default: 30000)
 */

// ── Конфигурация ──────────────────────────────────────────────────────────────

const ONEC_URL = (process.env.ONEC_URL || "").replace(/\/$/, "");
const ONEC_USERNAME = process.env.ONEC_USERNAME || "";
const ONEC_PASSWORD = process.env.ONEC_PASSWORD || "";
const ONEC_SERVICE_ROOT = process.env.ONEC_SERVICE_ROOT || "mcp";
const ONEC_TIMEOUT = parseInt(process.env.ONEC_TIMEOUT || "30000");

/**
 * Проверяет, настроено ли подключение к 1С.
 * @returns {boolean}
 */
export function isOnecConfigured() {
  return Boolean(ONEC_URL && ONEC_USERNAME);
}

/**
 * Возвращает конфигурацию подключения (без пароля).
 * @returns {{ url: string, username: string, serviceRoot: string, timeout: number, configured: boolean }}
 */
export function getOnecConfig() {
  return {
    url: ONEC_URL,
    username: ONEC_USERNAME,
    serviceRoot: ONEC_SERVICE_ROOT,
    timeout: ONEC_TIMEOUT,
    configured: isOnecConfigured(),
  };
}

// ── JSON-RPC клиент ───────────────────────────────────────────────────────────

let _requestId = 1;

/**
 * Выполняет JSON-RPC запрос к HTTP-сервису 1С.
 *
 * @param {string} method — метод JSON-RPC, например "tools/call" или "tools/list"
 * @param {object} params — параметры запроса
 * @returns {Promise<object>} — результат (поле result из ответа)
 * @throws {Error} при ошибке сети, 4xx/5xx, или JSON-RPC error
 */
export async function onecRpc(method, params = {}) {
  if (!isOnecConfigured()) {
    throw new OnecNotConfiguredError(
      "Подключение к 1С не настроено. " +
      "Укажите ONEC_URL и ONEC_USERNAME в переменных окружения (.env)."
    );
  }

  const rpcUrl = `${ONEC_URL}/hs/${ONEC_SERVICE_ROOT}/rpc`;
  const credentials = Buffer.from(`${ONEC_USERNAME}:${ONEC_PASSWORD}`).toString("base64");
  const id = _requestId++;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });

  // AbortController для таймаута (нативный fetch)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ONEC_TIMEOUT);

  let response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${credentials}`,
        "Accept": "application/json",
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new OnecTimeoutError(
        `Таймаут запроса к 1С (${ONEC_TIMEOUT}мс). Проверьте доступность ${rpcUrl}.`
      );
    }
    throw new OnecNetworkError(`Ошибка сети при подключении к 1С: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // Проверяем HTTP-статус
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new OnecAuthError(
        `Ошибка авторизации 1С (401). Проверьте ONEC_USERNAME и ONEC_PASSWORD.`
      );
    }
    if (response.status === 404) {
      throw new OnecNotFoundError(
        `HTTP-сервис не найден (404). Проверьте URL и убедитесь, что расширение установлено: ${rpcUrl}`
      );
    }
    throw new OnecHttpError(
      `Ошибка HTTP ${response.status} от 1С: ${text.slice(0, 200)}`
    );
  }

  // Разбираем JSON
  let json;
  try {
    json = await response.json();
  } catch (err) {
    throw new OnecParseError(`Ошибка разбора JSON-ответа от 1С: ${err.message}`);
  }

  // JSON-RPC error
  if (json.error) {
    const { code, message, data } = json.error;
    throw new OnecRpcError(
      `JSON-RPC ошибка ${code}: ${message}${data ? ` (${JSON.stringify(data)})` : ""}`,
      code, data
    );
  }

  return json.result;
}

/**
 * Вызывает инструмент 1С по имени с аргументами.
 * Удобная обёртка над onecRpc для вызова tools/call.
 *
 * @param {string} toolName — имя инструмента в расширении
 * @param {object} args — аргументы инструмента
 * @returns {Promise<object>}
 */
export async function callOnecTool(toolName, args = {}) {
  return onecRpc("tools/call", { name: toolName, arguments: args });
}

// ── Кэш health-check (TTL 60 сек, сбрасывается при ошибке) ──────────────────

const HEALTH_CACHE_TTL = 60_000; // мс
let _healthCache = null; // { result: {ok, detail}, at: timestamp }

/** Принудительно сбрасывает кэш health (например после изменения конфигурации). */
export function clearHealthCache() {
  _healthCache = null;
}

/**
 * Проверяет соединение с 1С (GET /health эндпоинт расширения).
 * Результат кэшируется на 60 секунд; при ошибке кэш сбрасывается немедленно.
 * @param {{ force?: boolean }} [options] — force=true игнорирует кэш
 * @returns {Promise<{ ok: boolean, detail?: string, cached?: boolean }>}
 */
export async function checkOnecHealth({ force = false } = {}) {
  if (!isOnecConfigured()) {
    return { ok: false, detail: "Не настроено (нет ONEC_URL или ONEC_USERNAME)" };
  }

  // Отдаём кэш если актуален
  if (!force && _healthCache && (Date.now() - _healthCache.at) < HEALTH_CACHE_TTL) {
    return { ..._healthCache.result, cached: true };
  }

  const healthUrl = `${ONEC_URL}/hs/${ONEC_SERVICE_ROOT}/health`;
  const credentials = Buffer.from(`${ONEC_USERNAME}:${ONEC_PASSWORD}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  let result;
  try {
    const response = await fetch(healthUrl, {
      headers: { "Authorization": `Basic ${credentials}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.ok) {
      const json = await response.json().catch(() => ({}));
      result = { ok: true, detail: json.status || "ok" };
    } else {
      result = { ok: false, detail: `HTTP ${response.status}` };
    }
  } catch (err) {
    clearTimeout(timer);
    result = { ok: false, detail: err.name === "AbortError" ? "timeout" : err.message };
  }

  if (result.ok) {
    // Кэшируем только успешный результат
    _healthCache = { result, at: Date.now() };
  } else {
    // При ошибке — сбрасываем кэш чтобы следующий вызов снова делал запрос
    _healthCache = null;
  }

  return result;
}

// ── Специализированные методы ─────────────────────────────────────────────────

/**
 * Получает список инструментов, доступных в расширении 1С.
 * @returns {Promise<{ tools: Array<{name, description, inputSchema}> }>}
 */
export async function listOnecTools() {
  return onecRpc("tools/list", {});
}

// ── Классы ошибок ─────────────────────────────────────────────────────────────

export class OnecError extends Error {
  constructor(message) {
    super(message);
    this.name = "OnecError";
  }
}

export class OnecNotConfiguredError extends OnecError {
  constructor(message) { super(message); this.name = "OnecNotConfiguredError"; }
}

export class OnecNetworkError extends OnecError {
  constructor(message) { super(message); this.name = "OnecNetworkError"; }
}

export class OnecTimeoutError extends OnecError {
  constructor(message) { super(message); this.name = "OnecTimeoutError"; }
}

export class OnecAuthError extends OnecError {
  constructor(message) { super(message); this.name = "OnecAuthError"; }
}

export class OnecNotFoundError extends OnecError {
  constructor(message) { super(message); this.name = "OnecNotFoundError"; }
}

export class OnecHttpError extends OnecError {
  constructor(message) { super(message); this.name = "OnecHttpError"; }
}

export class OnecParseError extends OnecError {
  constructor(message) { super(message); this.name = "OnecParseError"; }
}

export class OnecRpcError extends OnecError {
  constructor(message, code, data) {
    super(message);
    this.name = "OnecRpcError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Форматирует ошибку OnecError в читаемый JSON для возврата из MCP-инструмента.
 * @param {Error} err
 * @param {string} [hint] — дополнительная подсказка
 * @returns {string} — JSON-строка
 */
export function formatOnecError(err, hint = "") {
  const base = {
    error: err.name || "OnecError",
    message: err.message,
  };
  if (hint) base.hint = hint;
  if (err instanceof OnecNotConfiguredError) {
    base.setup_required = true;
    base.setup_steps = [
      "1. Установите расширение build/MCP_Сервер.cfe в вашу базу 1С",
      "2. Опубликуйте HTTP-сервис mcp_APIBackend через Apache/IIS",
      "3. Укажите ONEC_URL, ONEC_USERNAME, ONEC_PASSWORD в .env",
      "4. Перезапустите сервер"
    ];
  }
  return JSON.stringify(base, null, 2);
}
