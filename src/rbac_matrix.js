/**
 * rbac_matrix.js — матрица ролей RBAC и профили доступа 1С:БИТ.ФИНАНС.
 *
 * Данные вынесены в JSON и загружаются лениво:
 *   knowledge/rbac/roles_matrix.json    — 11 бизнес-функций (метаданные + роли)
 *   knowledge/rbac/access_profiles.json — 122 профиля групп доступа
 *
 * Раньше 5245 строк данных лежали прямо в этом модуле и разбирались V8-парсером
 * при каждом импорте (414 КБ JS). JSON.parse существенно быстрее, а данные
 * теперь можно править без риска сломать синтаксис кода.
 *
 * Источник профилей: "Профиль групп доступа БИТ Строительство (БИТ.ФИНАНС) КОРП.xlsx"
 * Конфигурация: БИТ:Строительство (БИТ.ФИНАНС) КОРП 3.0, платформа 8.3.27.1859
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RBAC_DIR = path.join(__dirname, "..", "knowledge", "rbac");

function readJson(fileName) {
  const full = path.join(RBAC_DIR, fileName);
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (err) {
    process.stderr.write(`[rbac_matrix] Не удалось прочитать ${full}: ${err.message}\n`);
    return null;
  }
}

export const RBAC_MATRIX = readJson("roles_matrix.json") || {
  _meta: { version: "0", description: "данные не загружены" },
  business_functions: [],
};

export const ACCESS_PROFILES = readJson("access_profiles.json") || [];

// Индекс бизнес-функций по id — заменяет линейный .find() внутри циклов
// по 122 профилям (было 122 × N × 11 сравнений при каждом подборе профиля).
export const BF_BY_ID = new Map(
  RBAC_MATRIX.business_functions.map((f) => [f.id, f])
);

/**
 * Автоматически заполняет business_function_ids для всех профилей ACCESS_PROFILES
 * на основе пересечения key_roles профиля с roles каждой бизнес-функции из RBAC_MATRIX.
 *
 * Нормализация: в ACCESS_PROFILES роли хранятся с префиксом "Роль.",
 * в RBAC_MATRIX — без него. Сравниваем без префикса.
 *
 * Вызывается один раз при инициализации модуля (IIFE в конце блока данных).
 */
function initBusinessFunctionIds() {
  for (const profile of ACCESS_PROFILES) {
    // Нормализуем роли профиля: убираем префикс "Роль." если есть
    const profileRolesNorm = new Set(
      profile.key_roles.map((r) => r.replace(/^Роль\./, ""))
    );

    profile.business_function_ids = RBAC_MATRIX.business_functions
      .filter((bf) => bf.roles.some((r) => profileRolesNorm.has(r)))
      .map((bf) => bf.id);
  }
}

// Инициализируем при загрузке модуля
initBusinessFunctionIds();

/**
 * Возвращает все профили, покрывающие указанную бизнес-функцию.
 *
 * @param {string} functionId - id бизнес-функции из RBAC_MATRIX (например "TRANSPORT_DISPATCHER")
 * @returns {{ profile: object, business_function: object } | null}
 */
export function getProfilesByFunction(functionId) {
  const bf = BF_BY_ID.get(functionId);
  if (!bf) return null;

  const profiles = ACCESS_PROFILES.filter((p) =>
    p.business_function_ids.includes(functionId)
  );

  return { business_function: bf, profiles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Специальная логика: доступ к БУ для не-бухгалтеров
//
// Правило (источник: регламент ГТИ):
//   Если сотрудник НЕ является бухгалтером и запрашивает доступ к БУ:
//     - редактирование/создание  → PROFILE_ГТИ_ДОБАВЛЕНИЕ_И_ИЗМЕНЕНИЕ_ДАННЫХ_БУХГАЛТЕРИИ_ПОКУПКА_ПРОДАЖА_СКЛАД
//     - только просмотр          → PROFILE_ГТИ_ЧТЕНИЕ_ДАННЫХ_БУХГАЛТЕРИИ_ПОКУПКА
//     - расширенный просмотр     → PROFILE_ГТИ_ЧТЕНИЕ_ДАННЫХ_БУХГАЛТЕРИИ_ПОКУПКА_ПРОДАЖА_СКЛАД
// ─────────────────────────────────────────────────────────────────────────────

const _BU_EDIT_KEYWORDS = [
  "редактирование бу", "создание бу", "редактировать бу", "создать бу",
  "изменение данных бухгалтерии", "добавление данных бухгалтерии",
  "заведение счетов", "заводить счета", "заведение документов бу",
  "первичные бу документы", "создавать бухгалтерские", "редактировать бухгалтерию",
  "счета на оплату создание", "создать счет бухгалтерия", "небухгалтер бу",
  "не бухгалтер бу", "небухгалтерская должность бу", "не являются бухгалтером",
  "редактирование бухгалтерского учёта", "редактирование бухгалтерского учета",
];

const _BU_EXTENDED_READ_KEYWORDS = [
  "расширенный просмотр бу", "расширенный просмотр бухгалтерии",
  "полный просмотр бу", "расширенное чтение бу", "не бухгалтер расширенный просмотр",
  "небухгалтер расширенный", "расширенный доступ бу", "просмотр покупка продажа склад",
  "чтение покупка продажа склад", "покупка продажа склад просмотр",
  "просмотр бухгалтерии покупка продажа склад", "чтение бухгалтерии покупка продажа",
];

const _BU_READ_KEYWORDS = [
  "только просмотр бу", "просмотр бухгалтерии", "чтение бу",
  "просмотр бухгалтерского учёта", "просмотр бухгалтерского учета",
  "не бухгалтер просмотр", "небухгалтер чтение", "только чтение бу",
  "просмотр данных бухгалтерии", "чтение данных бухгалтерии",
  "просмотр счетов на оплату", "просмотр документов бухгалтерии",
  "базовый просмотр бу", "просмотр покупка", "чтение покупки",
];

const _NON_ACCOUNTANT_TITLES = [
  "координатор", "инженер", "менеджер", "руководитель проект",
  "начальник участк", "мастер", "прораб", "кладовщик", "кладовщица",
  "снабженец", "логист", "диспетчер", "механик", "водитель",
  "специалист", "эксперт", "сметчик", "экономист",
  // явные отрицания
  "не бухгалтер", "небухгалтер", "не является бухгалтером",
  "не бухгалтерская должность",
];

const _ACCOUNTANT_TITLES = [
  "бухгалтер", "главбух", "главный бухгалтер",
  "заместитель главного бухгалтера", "зам главного бухгалтера",
  "бухгалтер-кассир", "бухгалтер по расчётам", "бухгалтер по учёту",
];

/**
 * Анализирует текст запроса и определяет контекст доступа к БУ для не-бухгалтеров.
 *
 * @param {string} lowerText — текст запроса в нижнем регистре
 * @returns {{ isBuRequest: boolean, isNonAccountant: boolean, buAccessType: 'edit'|'extended_read'|'read'|null }}
 */
function detectBuAccessContext(lowerText) {
  // Признаки запроса на доступ к БУ
  const hasBuSignal =
    lowerText.includes("бу ") || lowerText.includes(" бу") ||
    lowerText.includes("бухгалтерск") || lowerText.includes("бухгалтери") ||
    lowerText.includes("данных бухгалтер") || lowerText.includes("данные бухгалтер");

  if (!hasBuSignal) return { isBuRequest: false, isNonAccountant: false, buAccessType: null };

  // Проверяем, является ли запрос от бухгалтера (тогда правило не применяем).
  // Используем regex чтобы не ловить "бухгалтер" внутри "бухгалтерии"/"бухгалтерского".
  // Слово должно оканчиваться на: а, у, е, и, ов — словоформы должности, но НЕ продолжаться
  // буквами характерными для прилагательных (ск, ий, ого и т.д.).
  const isAccountant = /(?:^|\s|[,;(])(бухгалтер(?:а|у|е|ом|ами|ов|ша|ши|шу|шей|-кассир|-расчёт|-учёт)?)\b/u
    .test(lowerText) ||
    lowerText.includes("главбух") ||
    lowerText.includes("главный бухгалтер") ||
    lowerText.includes("зам главного бухгалтера") ||
    lowerText.includes("заместитель главного бухгалтера");

  // Проверяем признаки не-бухгалтерской должности
  const isNonAccountant = !isAccountant &&
    _NON_ACCOUNTANT_TITLES.some((t) => lowerText.includes(t));

  // Определяем тип доступа (приоритет: edit > extended_read > read)
  const isEdit         = _BU_EDIT_KEYWORDS.some((kw) => lowerText.includes(kw));
  const isExtendedRead = _BU_EXTENDED_READ_KEYWORDS.some((kw) => lowerText.includes(kw));
  const isRead         = _BU_READ_KEYWORDS.some((kw) => lowerText.includes(kw));

  let buAccessType = null;
  if (isEdit)              buAccessType = "edit";
  else if (isExtendedRead) buAccessType = "extended_read";
  else if (isRead)         buAccessType = "read";

  return { isBuRequest: hasBuSignal, isNonAccountant, buAccessType };
}

/**
 * Возвращает id профиля ГТИ для доступа к БУ по типу.
 */
function getBuProfileId(buAccessType) {
  if (buAccessType === "edit")          return "PROFILE_ГТИ_ДОБАВЛЕНИЕ_И_ИЗМЕНЕНИЕ_ДАННЫХ_БУХГАЛТЕРИИ_ПОКУПКА_ПРОДАЖА_СКЛАД";
  if (buAccessType === "extended_read") return "PROFILE_ГТИ_ЧТЕНИЕ_ДАННЫХ_БУХГАЛТЕРИИ_ПОКУПКА_ПРОДАЖА_СКЛАД";
  if (buAccessType === "read")          return "PROFILE_ГТИ_ЧТЕНИЕ_ДАННЫХ_БУХГАЛТЕРИИ_ПОКУПКА";
  return null;
}

/**
 * Подбирает ВСЕ подходящие профили доступа по тексту запроса и/или набору ролей.
 * Возвращает массив, отсортированный по score DESC. Профили с score=0 исключаются.
 *
 * @param {string} requestText
 * @param {string[]} roles
 * @returns {{ profile: object, score: number, explanation: string }[]}
 */
export function suggestProfiles(requestText = "", roles = []) {
  const lowerText = requestText.toLowerCase();
  const rolesSet = new Set(roles);
  const results = [];

  // ── Специальная логика: БУ-доступ для не-бухгалтеров ──────────────────────
  const buCtx = detectBuAccessContext(lowerText);
  const buTargetId = (buCtx.isBuRequest && buCtx.isNonAccountant && buCtx.buAccessType)
    ? getBuProfileId(buCtx.buAccessType)
    : null;

  for (const profile of ACCESS_PROFILES) {
    let score = 0;
    const matchedKeywords = [];
    const matchedRoles = [];

    for (const kw of profile.keywords) {
      if (lowerText.includes(kw.toLowerCase())) {
        score += 2;
        matchedKeywords.push(kw);
      }
    }
    for (const role of profile.key_roles) {
      if (rolesSet.has(role)) {
        score += 3;
        matchedRoles.push(role);
      }
    }
    for (const funcId of profile.business_function_ids) {
      const func = BF_BY_ID.get(funcId);
      if (func) {
        const funcRoleMatches = func.roles.filter(r => rolesSet.has(r));
        score += funcRoleMatches.length;
      }
    }

    // Буст для целевого ГТИ БУ-профиля (не-бухгалтер + явный тип доступа)
    if (buTargetId && profile.id === buTargetId) {
      score += 20;
      matchedKeywords.push(`[ГТИ БУ: ${buCtx.buAccessType}]`);
    }

    if (score > 0) {
      const explanation = [
        matchedKeywords.length > 0 ? `Совпадение ключевых слов: ${matchedKeywords.join(", ")}` : null,
        matchedRoles.length > 0    ? `Совпадение ролей: ${matchedRoles.join(", ")}` : null,
      ].filter(Boolean).join(". ") || "Подобран по косвенным признакам";
      results.push({ profile, score, explanation });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Подбирает наиболее подходящий профиль доступа по тексту запроса и/или набору ролей.
 *
 * Алгоритм:
 * 1. Считаем score для каждого профиля: совпадение ключевых слов в тексте + покрытие ролей
 * 2. Возвращаем профиль с максимальным score
 *
 * @param {string} requestText  - свободный текст описания задач пользователя
 * @param {string[]} roles      - список определённых ролей 1С (опционально)
 * @returns {{ profile: object, score: number, explanation: string }}
 */
export function suggestProfile(requestText = "", roles = []) {
  const lowerText = requestText.toLowerCase();
  const rolesSet = new Set(roles);

  // ── Специальная логика: БУ-доступ для не-бухгалтеров ──────────────────────
  const buCtx = detectBuAccessContext(lowerText);
  const buTargetId = (buCtx.isBuRequest && buCtx.isNonAccountant && buCtx.buAccessType)
    ? getBuProfileId(buCtx.buAccessType)
    : null;

  let best = null;
  let bestScore = -1;
  let bestExplanation = "";

  for (const profile of ACCESS_PROFILES) {
    let score = 0;
    const matchedKeywords = [];
    const matchedRoles = [];

    // 1. Совпадение ключевых слов
    for (const kw of profile.keywords) {
      if (lowerText.includes(kw.toLowerCase())) {
        score += 2;
        matchedKeywords.push(kw);
      }
    }

    // 2. Покрытие ключевых ролей профиля
    for (const role of profile.key_roles) {
      if (rolesSet.has(role)) {
        score += 3;
        matchedRoles.push(role);
      }
    }

    // 3. Покрытие бизнес-функций
    for (const funcId of profile.business_function_ids) {
      const func = BF_BY_ID.get(funcId);
      if (func) {
        const funcRoleMatches = func.roles.filter(r => rolesSet.has(r));
        score += funcRoleMatches.length;
      }
    }

    // 4. Буст для целевого ГТИ БУ-профиля (не-бухгалтер + явный тип доступа)
    if (buTargetId && profile.id === buTargetId) {
      score += 20;
      matchedKeywords.push(`[ГТИ БУ: ${buCtx.buAccessType}]`);
    }

    if (score > bestScore) {
      bestScore = score;
      best = profile;
      bestExplanation = [
        matchedKeywords.length > 0 ? `Совпадение ключевых слов: ${matchedKeywords.join(", ")}` : null,
        matchedRoles.length > 0    ? `Совпадение ролей: ${matchedRoles.join(", ")}` : null,
      ].filter(Boolean).join(". ") || "Подобран по косвенным признакам";
    }
  }

  return {
    profile: best,
    score: bestScore,
    explanation: bestExplanation
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты согласования — единая реализация, используется во всех инструментах
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Вычисляет уровень согласования по флагам профиля/функции.
 *
 * @param {{ requires_chief_accountant?: boolean, requires_transport_head?: boolean, requires_procurement_director?: boolean }} flags
 * @returns {"standard" | "accounting" | "transport" | "transport_accounting" | "procurement"}
 */
export function computeApprovalLevel(flags = {}) {
  const acc = Boolean(flags.requires_chief_accountant);
  const tr  = Boolean(flags.requires_transport_head);
  const pr  = Boolean(flags.requires_procurement_director);
  if (acc && tr) return "transport_accounting";
  if (acc)       return "accounting";
  if (tr)        return "transport";
  if (pr)        return "procurement";
  return "standard";
}

/**
 * Вычисляет агрегированный уровень согласования по массиву флагов.
 *
 * @param {Array<{ requires_chief_accountant?: boolean, requires_transport_head?: boolean, requires_procurement_director?: boolean }>} flagsArray
 * @returns {"standard" | "accounting" | "transport" | "transport_accounting" | "procurement"}
 */
export function computeApprovalLevelMany(flagsArray = []) {
  const acc = flagsArray.some((f) => f.requires_chief_accountant);
  const tr  = flagsArray.some((f) => f.requires_transport_head);
  const pr  = flagsArray.some((f) => f.requires_procurement_director);
  return computeApprovalLevel({ requires_chief_accountant: acc, requires_transport_head: tr, requires_procurement_director: pr });
}

/**
 * Формирует список согласующих лиц.
 *
 * @param {{ requires_chief_accountant?: boolean, requires_transport_head?: boolean, requires_procurement_director?: boolean }} flags
 * @returns {string[]}
 */
export function formatApprovers(flags = {}) {
  const list = ["Линейный руководитель (всегда)"];
  if (flags.requires_chief_accountant) list.push("Главный бухгалтер (есть роли БУ/НУ или казначейства)");
  if (flags.requires_transport_head)   list.push("Руководитель отдела АТ (есть транспортные роли)");
  if (flags.requires_procurement_director) list.push("Директор по закупкам (есть роли закупок)");
  return list;
}

/**
 * Возвращает человекочитаемое описание уровня согласования.
 *
 * @param {"standard"|"accounting"|"transport"|"transport_accounting"|"procurement"} level
 * @returns {string}
 */
export function describeApprovalLevel(level) {
  return {
    standard:             "Стандартное — только линейный руководитель",
    accounting:           "Расширенное — руководитель + главный бухгалтер",
    transport:            "Транспортное — руководитель + руководитель АТ",
    transport_accounting: "Комплексное — руководитель + главный бухгалтер + руководитель АТ",
    procurement:          "Закупочное — руководитель + директор по закупкам",
  }[level] || "Неизвестный уровень";
}

/**
 * Формирует системный промпт для LLM с полной матрицей ролей и профилями доступа.
 */
export function buildSystemPrompt() {
  const matrixJson = JSON.stringify(RBAC_MATRIX, null, 2);

  // Краткая сводка профилей для промпта (без key_roles — они занимают много токенов)
  const profilesSummary = ACCESS_PROFILES.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    keywords: p.keywords,
    business_function_ids: p.business_function_ids,
    requires_chief_accountant: p.requires_chief_accountant,
    requires_transport_head: p.requires_transport_head
  }));

  return `Ты — AI-аналитик доступов в системе 1С:Предприятие (конфигурация БИТ:Строительство / БИТ.ФИНАНС КОРП 3.0).

Твоя задача: проанализировать описание должности/функций нового сотрудника и определить:
1. Какие бизнес-функции он будет выполнять
2. Какой профиль группы доступа из списка ниже наиболее подходит (вернуть ТОЛЬКО ОДИН профиль)
3. Нужно ли согласование главного бухгалтера (только для БУ/НУ ролей и казначейства)
4. Нужно ли согласование руководителя автотранспорта (только для транспортных ролей)

МАТРИЦА РОЛЕЙ:
${matrixJson}

ПРОФИЛИ ГРУПП ДОСТУПА (заведены в продуктивной базе):
${JSON.stringify(profilesSummary, null, 2)}

ПРАВИЛА ПОДБОРА ПРОФИЛЯ:
- Выбирай профиль с минимально необходимыми правами (принцип минимальных привилегий)
- ВАЖНО: профиль "Только просмотр" даёт доступ ко ВСЕЙ базе 1С:БИТ. Предоставляется ТОЛЬКО по согласованию главного бухгалтера и непосредственного руководителя. НЕ предлагай его рядовым сотрудникам — только руководителям, аналитикам или по явному запросу с обоснованием
- Если пользователь работает только с просмотром отчётов — используй "БИТ.Только просмотр" (требует главбуха!)
- Если нужны только закупки/договоры/снабжение — "БИТ.Специалист по закупкам" или "БИТ.Исполнитель по заявкам на потребность"
- Если казначейство/оплата — "БИТ.Исполнитель казначейства" или "БИТ.Казначей" (казначей имеет больше прав)
- Если только бюджеты — "БИТ.Исполнитель бюджетирования"
- Если комплексные финансовые функции — "БИТ.Финансист - модель БСП"
- Если транспорт/путевые листы — "Автотранспорт: Диспетчер (БИТ)"
- Если несколько несвязанных функций — выбирай профиль с наибольшим покрытием

ПРАВИЛА:
- Если упомянут бухгалтерский или налоговый учёт → requires_chief_accountant = true
- Если упомянут транспорт, путевые листы, ГСМ → requires_transport_head = true
- confidence: 0.0–1.0 (уверенность в подборе)

ФОРМАТ ОТВЕТА — строго JSON без markdown:
{
  "business_functions": ["функция 1", "функция 2"],
  "recommended_profile": {
    "id": "PROFILE_ID",
    "name": "Полное наименование профиля",
    "reason": "Почему выбран именно этот профиль"
  },
  "requires_chief_accountant": false,
  "requires_transport_head": false,
  "approval_level": "standard|accounting|transport|transport_accounting",
  "confidence": 0.95,
  "reasoning": "Общее объяснение"
}`;
}
