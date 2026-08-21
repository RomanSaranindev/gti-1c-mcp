#!/usr/bin/env node
/**
 * gti-1c-mcp — MCP-сервер
 *
 * Транспорт: Streamable HTTP (stateful, SDK 1.12+)
 * Порт: 3031 (по умолчанию)
 *
 * Роли и доступ к инструментам — см. TOOL_ACCESS ниже. Кратко:
 *   user    — база знаний инструкций + check_document_access (свои права)
 *   analyst — всё, кроме execute_1c_query
 *   admin   — всё
 *
 * Инструменты (18):
 *
 * База знаний инструкций 1С.БИТ (роль user):
 *   1. list_instructions              — список инструкций (фильтры: code, keyword, topic, list_topics)
 *   2. search_instructions            — поиск: keyword / semantic (TF-IDF + cosine) / auto
 *   3. get_instruction                — полный текст инструкции по id или коду (ИП-301 и т.д.)
 *
 * Самодиагностика прав (роль user):
 *   3a. check_document_access         — каких прав не хватает для работы с документом
 *
 * Профили доступа и матрица ролей RBAC:
 *   4. suggest_access_profile         — подбор профиля (двухшаговый протокол + generate_request_text)
 *   5. get_roles_matrix               — полная матрица ролей RBAC с фильтрами
 *   6. analyze_roles                  — валидация + уровень согласования за один вызов
 *   7. get_profiles_by_function       — профили доступа по бизнес-функции RBAC
 *   8. explain_profile                — объяснение профиля на языке бизнеса
 *   9. search_by_role                 — поиск профилей и бизнес-функций по роли 1С
 *
 * Маппинг должность → профили (обезличенные данные сотрудников):
 *  10. suggest_profile_by_job         — типовые профили по названию должности (include_explanation)
 *  11. list_jobs                      — список должностей из базы данных
 *
 * Связка инструкция ↔ доступ:
 *  12. get_instruction_access_requirements — профили и роли, нужные для инструкции (topic-маппинг)
 *  13. get_user_access_journey             — полная цепочка должность→профиль→роли→согласование
 *
 * Живая база 1С (требует расширение + ONEC_* в .env):
 *  14. onec_health                    — статус подключения к 1С (кэш 60 сек)
 *  15. list_1c_users                  — список пользователей базы
 *  16. get_1c_access_groups           — группы доступа пользователя
 *  17. execute_1c_query               — произвольный запрос к данным 1С
 *  18. get_1c_metadata                — метаданные конфигурации 1С
 *  19. get_1c_documents               — документы БИТ.ФИНАНС с фильтрацией
 *  20. get_visa_routes               — визы, маршруты, права установки, шаги алгоритма (живые данные)
 *
 * Маршруты согласования (knowledge/routes/routes_db.json):
 *  20. list_routes                    — список доступных маршрутов по организациям
 *  21. suggest_route                  — подбор цепочки согласования по параметрам (БЕ, тип, сумма, ЦФО и др.)
 *  22. get_route                      — полный маршрут организации (все варианты/шаги/условия)
 *  23. compare_routes                 — сравнение маршрутов двух организаций
 *  24. validate_route_params          — валидация параметров перед подбором маршрута
 */

// TLS к корпоративному IIS проверяется строго.
// Доверие к внутреннему УЦ задаётся через NODE_EXTRA_CA_CERTS в .env
// (cert/hg-ca-bundle.pem: HG Root CA + HG Issuing CA).
// Отключать проверку сертификата нельзя: пароль 1С уходит в Basic-auth,
// и без проверки соединение открыто для MITM.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  loadKnowledgeBase,
  getLoadedDocs,
  listInstructions,
  searchInstructions,
  getInstruction,
  listTopics,
  getInstructionsByTopic,
} from "./knowledge_base.js";

import {
  buildTfidfIndex,
  tfidfSearch,
  getIndexStats,
  getSearchCacheStats,
  clearSearchCache,
} from "./vector_search.js";

import {
  isOnecConfigured,
  getOnecConfig,
  onecRpc,
  callOnecTool,
  checkOnecHealth,
  listOnecTools,
  formatOnecError,
  unwrapOnecPayload,
} from "./onec_client.js";

import {
  jsonReply,
  liveReply,
  errorReply,
  onecTool,
} from "./mcp_reply.js";

import { renderRouteMermaid } from "./route_mermaid.js";

import {
  reloadDb as reloadRoutesDb,
  suggestRoute,
  getRoute,
  compareRoutes,
  listRoutes,
  validateRouteParams,
} from "./routes_engine.js";

import { verifyToken, credentialsFor, touchToken, loadTokens, roleAtLeast } from "./auth.js";
import { withCredentials } from "./onec_client.js";

// ── Конфигурация ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || process.env.MCP_PORT || "3031");

// Версия читается из package.json — раньше она была прописана в трёх местах
// (/health, /, Dockerfile) и везде разная.
const SERVER_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
).version;

/**
 * Безопасный вывод лога: всегда в stderr.
 * В stdio-режиме stdout занят MCP-протоколом — любой вывод в stdout его сломает.
 * В HTTP-режиме stderr и stdout эквивалентны, но единообразие лучше.
 */
function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

// ── Аудит ─────────────────────────────────────────────────────────────────────
//
// Требование ИБ: по журналу должно быть видно, кто именно выполнил запрос.
// Пишем в stderr одной строкой на вызов — так запись подхватит любой сборщик
// логов (journald, Filebeat) без дополнительной настройки.

/**
 * Запись в журнал аудита.
 *
 * @param {object} ctx    — { id, login, role } из записи токена
 * @param {string} action — что произошло: имя инструмента или событие
 * @param {object} [details] — доп. поля (текст запроса, результат)
 */
function audit(ctx, action, details = {}) {
  const record = {
    ts: new Date().toISOString(),
    actor: ctx?.login || "anonymous",
    token_id: ctx?.id || "-",
    role: ctx?.role || "-",
    action,
    ...details,
  };
  process.stderr.write("AUDIT " + JSON.stringify(record) + "\n");
}

// ── Ограничение доступа по ролям ──────────────────────────────────────────────

/**
 * Минимальная роль для каждого инструмента — единственный источник правды.
 *
 * Замысел разграничения:
 *   user    — рядовой сотрудник. Ему нужны инструкции («как оформить документ»)
 *             и ответ на вопрос «каких прав мне не хватает». Данные живой базы
 *             (документы, пользователи, визы, маршруты) он через агента не видит.
 *   analyst — работает с данными: маршруты, визы, права, документы, метаданные.
 *   admin   — плюс execute_1c_query: произвольный запрос к любой таблице базы,
 *             то есть прямой доступ к данным в обход остальных инструментов.
 *
 * Инструмент, отсутствующий в карте, недоступен никому (fail-closed): забыть
 * добавить новый инструмент безопаснее, чем случайно открыть его всем.
 */
const TOOL_ACCESS = {
  // ── База знаний инструкций — доступна всем ────────────────────────────────
  list_instructions:      "user",
  search_instructions:    "user",
  get_instruction:        "user",

  // Самодиагностика прав: «каких прав мне не хватает для работы с документом».
  // Роль user всегда получает ответ только про себя (см. проверку в обработчике).
  check_document_access:  "user",

  // ── Маршруты согласования (локальная база знаний) ─────────────────────────
  list_routes:            "analyst",
  suggest_route:          "analyst",
  get_route:              "analyst",
  compare_routes:         "analyst",
  validate_route_params:  "analyst",

  // ── Живая база 1С ─────────────────────────────────────────────────────────
  onec_health:            "analyst",
  list_1c_users:          "analyst",
  get_1c_access_groups:   "analyst",
  get_1c_metadata:        "analyst",
  get_1c_documents:       "analyst",
  get_visa_routes:        "analyst",
  get_user_rights:        "analyst",
  get_user_visas:         "analyst",

  // Произвольный запрос — только admin
  execute_1c_query:       "admin",
};

/**
 * Возвращает имена инструментов, доступных роли.
 * Используется при регистрации: недоступные инструменты не попадают
 * в tools/list, поэтому агент не тратит вызовы на заведомые отказы.
 *
 * @param {string} role
 * @returns {Set<string>}
 */
function toolsForRole(role) {
  return new Set(
    Object.entries(TOOL_ACCESS)
      .filter(([, required]) => roleAtLeast(role, required))
      .map(([name]) => name)
  );
}

/**
 * Оборачивает обработчик инструмента проверкой роли и записью в аудит.
 *
 * Проверка остаётся даже при скрытии инструментов из tools/list: список —
 * это удобство для агента, а не граница безопасности. Клиент может вызвать
 * инструмент по имени, не спрашивая список.
 *
 * @param {string} name — имя инструмента
 * @param {Function} handler — исходный обработчик
 * @param {() => object|null} getCtx — контекст текущего пользователя
 * @returns {Function}
 */
function guard(name, handler, getCtx) {
  return async (args, extra) => {
    const ctx = getCtx();

    // getCtx() возвращает null в stdio-режиме: там сервер запущен локально
    // самим пользователем под учёткой из .env, роли не применяются.
    const required = TOOL_ACCESS[name];
    if (ctx && !roleAtLeast(ctx.role, required || "admin")) {
      audit(ctx, name, { result: "denied", reason: `требуется роль ${required || "admin"}` });
      return jsonReply({
        error: "Forbidden",
        message:
          `Инструмент '${name}' требует роль '${required || "admin"}' или выше. ` +
          `Ваша роль: '${ctx.role || "не определена"}'.`,
        hint: required === "admin"
          ? "Произвольный запрос к базе доступен только администратору. " +
            "Для решения задачи используйте специализированные инструменты."
          : "Доступные вам инструменты перечислены в списке инструментов сервера. " +
            "За расширением доступа обратитесь к администратору сервера.",
      });
    }

    const started = Date.now();
    try {
      const result = await handler(args, extra);
      audit(ctx, name, { result: "ok", ms: Date.now() - started, args: auditArgs(name, args) });
      return result;
    } catch (err) {
      audit(ctx, name, { result: "error", ms: Date.now() - started, error: err.message });
      throw err;
    }
  };
}

/**
 * Отбирает аргументы, безопасные для журнала.
 * Для execute_1c_query текст запроса пишем целиком — это ключевая информация
 * для разбора инцидента. Остальные инструменты логируем только по именам полей,
 * чтобы в журнал не попали данные из фильтров.
 */
function auditArgs(name, args) {
  if (!args || typeof args !== "object") return undefined;
  if (name === "execute_1c_query") return { query: args.query_text, limit: args.limit };
  const keys = Object.keys(args).filter((k) => args[k] !== undefined);
  return keys.length ? keys.join(",") : undefined;
}

// ── Реестр инструментов ───────────────────────────────────────────────────────
//
// Единый источник правды для /status и /. При добавлении нового server.tool()
// обязательно добавить имя в нужную группу.

const TOOL_GROUPS = {
  knowledge_base: [
    "list_instructions",                    // фильтры: code, keyword, topic, list_topics
    "search_instructions",                  // mode: auto | semantic | keyword
    "get_instruction",
  ],
  self_service: [
    "check_document_access",                // свои права на документ (роль user)
  ],
  routes: [
    "list_routes",
    "suggest_route",
    "get_route",
    "compare_routes",
    "validate_route_params",
  ],
  live_1c: [
    "onec_health",                          // кэш 60 сек, пер-пользователя
    "list_1c_users",                        // без ФИО — только user_uid
    "get_1c_access_groups",
    "execute_1c_query",                     // только роль admin
    "get_1c_metadata",
    "get_1c_documents",
    "get_visa_routes",                      // визы, маршруты, права, алгоритмы, граф
    "get_user_rights",                      // группы + профили по user_ref (без ФИО)
    "get_user_visas",                       // визы по user_uid (без ФИО)
  ],
};

const TOOL_GROUPS_FLAT = Object.values(TOOL_GROUPS).flat();

// Блок-схема маршрута согласования вынесена в отдельный модуль (см. route_mermaid.js)

// ── Регистрация инструментов ──────────────────────────────────────────────────

/**
 * Регистрирует инструменты в экземпляре McpServer.
 *
 * @param {McpServer} server
 * @param {() => ({id: string, login: string, role: string}|null)} [getCtx]
 *        Возвращает пользователя текущей сессии. Каждая HTTP-сессия привязана
 *        к своему токену, поэтому контекст передаётся при создании сервера.
 *        В stdio-режиме контекста нет — там сервер запущен локально самим
 *        пользователем и работает под учёткой из .env.
 */
function registerTools(server, getCtx = () => null) {

  // Роль владельца сессии известна на момент регистрации: каждая HTTP-сессия
  // получает свой экземпляр McpServer. Поэтому инструменты не своей роли
  // не регистрируются вовсе — агент не видит их в tools/list и не тратит
  // вызовы на заведомые отказы.
  //
  // В stdio-режиме контекста нет (сервер запущен локально под учёткой из .env) —
  // регистрируются все инструменты.
  const ctx = getCtx();
  const allowed = ctx ? toolsForRole(ctx.role) : null;

  // Проверка роли и аудит навешиваются на все инструменты сразу, а не
  // расставляются по 27 вызовам: так новый инструмент невозможно случайно
  // зарегистрировать в обход проверки.
  const rawTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    if (allowed && !allowed.has(name)) return undefined;
    const handler = rest.pop();
    return rawTool(name, ...rest, guard(name, handler, getCtx));
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 1: list_instructions  (объединяет бывший list_instructions_by_topic)
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "list_instructions",
    "Возвращает список инструкций пользователя 1С.БИТ из базы знаний MCP сервера. " +
    "Поддерживает фильтрацию по коду (ИП-301), ключевому слову в названии и тематическому разделу. " +
    "Доступные разделы: Казначейство, Транспорт и ГСМ, Склад и снабжение, Бюджетирование, " +
    "Бухгалтерия, Закупки и договоры, Номенклатура и НСИ, ЭДО, Методические, Доступ и роли. " +
    "Параметр list_topics=true вернёт список всех разделов с количеством инструкций.",
    {
      filter_code: z.string().optional().describe(
        "Фильтр по коду инструкции, например 'ИП-301'"
      ),
      filter_keyword: z.string().optional().describe(
        "Фильтр по ключевому слову в названии"
      ),
      topic: z.string().optional().describe(
        "Фильтр по тематическому разделу (частичное совпадение). " +
        "Например: 'Казначейство', 'Транспорт', 'Склад'"
      ),
      list_topics: z.boolean().optional().describe(
        "Если true — вернуть только список разделов с количеством инструкций в каждом"
      ),
    },
    async ({ filter_code, filter_keyword, topic, list_topics }) => {

      // ── Режим: вернуть список разделов ──────────────────────────────────────
      if (list_topics) {
        const topics = listTopics();
        const topicStats = topics.map((t) => ({
          topic: t,
          instructions_count: getInstructionsByTopic(t).length,
        }));
        const withoutTopic = listInstructions().filter((d) => !d.topic);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              available_topics: topicStats,
              without_topic_count: withoutTopic.length,
              hint: "Используйте параметр topic='Казначейство' для фильтрации по разделу.",
            }, null, 2),
          }],
        };
      }

      // ── Режим: список инструкций с фильтрами ────────────────────────────────
      let docs = topic ? getInstructionsByTopic(topic) : listInstructions();

      if (filter_code) {
        const norm = filter_code.toUpperCase().replace(/\s+/g, "");
        docs = docs.filter(
          (d) => d.code && d.code.toUpperCase().replace(/\s+/g, "") === norm
        );
      }
      if (filter_keyword) {
        const kw = filter_keyword.toLowerCase();
        docs = docs.filter(
          (d) =>
            (d.title || "").toLowerCase().includes(kw) ||
            (d.code  || "").toLowerCase().includes(kw)
        );
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: docs.length,
            filters: { filter_code, filter_keyword, topic },
            instructions: docs,
            hint: docs.length > 0
              ? "Используйте get_instruction(id) для получения полного текста инструкции."
              : "Инструкции не найдены. Попробуйте list_instructions(list_topics=true) чтобы увидеть доступные разделы.",
          }, null, 2),
        }],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 2: search_instructions  (объединяет бывший semantic_search_instructions)
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "search_instructions",
    "Ищет инструкции пользователя 1С.БИТ по запросу. " +
    "Режим mode='auto' (по умолчанию): сначала пробует нейронные эмбеддинги, затем TF-IDF + cosine. " +
    "Режим mode='semantic': TF-IDF + cosine similarity (понимает синонимы и смысл запроса). " +
    "Режим mode='keyword': точный полнотекстовый поиск по словам. " +
    "Используйте для ответов на вопросы 'как оформить...', 'где найти...', 'как заполнить...' в 1С.БИТ.",
    {
      query: z.string().describe(
        "Поисковый запрос на русском языке. " +
        "Например: 'путевой лист', 'приходный ордер от поставщика', 'как оформить расход топлива'"
      ),
      limit: z.number().int().min(1).max(20).default(5).describe(
        "Максимум результатов (по умолчанию 5)"
      ),
      mode: z.enum(["auto", "semantic", "keyword"]).default("auto").describe(
        "'auto' — то же что 'semantic' (рекомендуется). " +
        "'semantic' — TF-IDF + cosine similarity, понимает синонимы и смысл запроса. " +
        "'keyword' — точный полнотекстовый поиск по словам."
      ),
      min_score: z.number().min(0).max(1).default(0.01).describe(
        "Минимальный порог релевантности (0.0–1.0)."
      ),
    },
    async ({ query, limit, mode, min_score }) => {
      try {
        // ── Режим keyword ──────────────────────────────────────────────────
        if (mode === "keyword") {
          const result = searchInstructions(query, { limit });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ...result, search_mode: "keyword" }, null, 2),
            }],
          };
        }

        // ── Режим auto / semantic: TF-IDF + cosine ─────────────────────────
        const stats = getIndexStats();
        if (!stats.ready) {
          // Индекс ещё строится — деградируем в keyword, а не отдаём ошибку
          const result = searchInstructions(query, { limit });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ...result,
                search_mode: "keyword_fallback",
                note: "TF-IDF индекс ещё строится, использован полнотекстовый поиск.",
              }, null, 2),
            }],
          };
        }

        const result = tfidfSearch(query, { limit, minScore: min_score });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ...result, search_mode: "tfidf" }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "SearchFailed",
              message: err.message,
              hint: "Попробуйте mode='keyword' или проверьте /health.",
            }, null, 2),
          }],
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 3: get_instruction
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_instruction",
    "Возвращает полный текст инструкции пользователя 1С.БИТ по id (из list_instructions/search_instructions) " +
    "или по коду (ИП-301, ИП-403 и т.д.).",
    {
      id: z.string().describe(
        "Идентификатор инструкции (имя файла .md) или код инструкции, например 'ИП-301'"
      ),
      max_chars: z.number().int().min(500).max(200000).optional().describe(
        "Ограничение длины возвращаемого текста в символах"
      ),
    },
    async ({ id, max_chars }) => {
      const doc = getInstruction(id);

      if (!doc) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Инструкция не найдена",
                  id,
                  hint: "Используйте list_instructions для получения доступных id",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      let text = doc.content;
      if (max_chars && text.length > max_chars) {
        text = text.slice(0, max_chars) + `\n\n...[обрезано: всего ${doc.content.length} символов]`;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: doc.id,
                code: doc.code,
                title: doc.title,
                source: doc.source,
                type: doc.type,
                charCount: doc.content.length,
                truncated: !!(max_chars && doc.content.length > max_chars),
                content: text,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );


  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТЫ 12–16: Живая база 1С (через HTTP-сервис расширения)
  // Требуют ONEC_URL, ONEC_USERNAME, ONEC_PASSWORD в .env
  // и установленного расширения build/MCP_Сервер.cfe
  // ═══════════════════════════════════════════════════════════════════════════

  // ── 12: onec_health ────────────────────────────────────────────────────────

  server.tool(
    "onec_health",
    "Проверяет доступность HTTP-сервиса рабочей базы 1С. " +
    "Показывает статус подключения, конфигурацию и список инструментов, " +
    "которые расширение предоставляет агенту. " +
    "Вызывайте первым при любой работе с живой базой 1С.",
    {},
    async () => {
      const config = getOnecConfig();

      if (!config.configured) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              connected: false,
              reason: "Не настроено",
              hint: "Укажите ONEC_URL, ONEC_USERNAME, ONEC_PASSWORD в .env и перезапустите сервер",
              setup_steps: [
                "1. Установите расширение build/MCP_Сервер.cfe в базу 1С",
                "2. Опубликуйте HTTP-сервис mcp_APIBackend через Apache/IIS",
                "3. Добавьте в .env: ONEC_URL, ONEC_USERNAME, ONEC_PASSWORD",
                "4. Перезапустите: npm start",
              ],
              config: { url: config.url || "(не задан)", configured: false },
            }, null, 2),
          }],
        };
      }

      // Проверяем /health
      const health = await checkOnecHealth();

      // Пробуем получить список инструментов
      let tools = null;
      let toolsError = null;
      if (health.ok) {
        try {
          const toolsResult = await listOnecTools();
          tools = toolsResult?.tools || toolsResult;
        } catch (err) {
          toolsError = err.message;
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            connected: health.ok,
            health_status: health.detail,
            config: {
              url: config.url,
              username: config.username,
              service_root: config.serviceRoot,
              timeout_ms: config.timeout,
            },
            onec_tools_available: tools
              ? (Array.isArray(tools) ? tools.map(t => ({ name: t.name, description: t.description })) : tools)
              : null,
            onec_tools_error: toolsError || undefined,
            hint: health.ok
              ? "Подключение работает. Используйте инструменты onec_* для работы с данными."
              : "Проверьте URL, логин/пароль и доступность HTTP-сервиса 1С.",
          }, null, 2),
        }],
      };
    }
  );

  // ── 13: list_1c_users ──────────────────────────────────────────────────────

  server.tool(
    "list_1c_users",
    "Список пользователей рабочей базы 1С БЕЗ ФИО. " +
    "Возвращает: user_uid (ИдентификаторПользователяИБ), подразделение, " +
    "структурное подразделение, признаки активности. " +
    "ФИО и логины НЕ передаются — поиск по имени выполняется внутри 1С. " +
    "Полученный user_uid используйте в get_user_rights и get_user_visas. " +
    "Требует настроенного подключения к 1С (ONEC_URL, ONEC_USERNAME, ONEC_PASSWORD в .env).",
    {
      search: z.string().optional().describe(
        "Поиск по ФИО или логину (частичное совпадение). " +
        "Выполняется внутри 1С — ФИО в ответе НЕ возвращается, только user_uid."
      ),
      department: z.string().optional().describe(
        "Фильтр по подразделению (частичное совпадение)"
      ),
      limit: z.number().int().min(1).max(200).default(50).describe(
        "Максимум записей в ответе (по умолчанию 50)"
      ),
      include_inactive: z.boolean().default(false).describe(
        "Включать недействительных пользователей (по умолчанию false)"
      ),
    },
    onecTool(async ({ search, department, limit, include_inactive }) => {
      const result = await callOnecTool("get_users", {
        search: search || "",
        department: department || "",
        limit,
        include_inactive: include_inactive ? "true" : "false",
      });
      return liveReply(unwrapOnecPayload(result));
    }, "Для получения списка пользователей используйте инструмент onec_health для диагностики подключения.")
  );

  // ── 14: get_1c_access_groups ───────────────────────────────────────────────

  server.tool(
    "get_1c_access_groups",
    "Группы доступа рабочей базы 1С: наименование, профиль, количество участников. " +
    "Опционально — список ролей профиля (include_roles=true). " +
    "Можно отфильтровать по названию группы или по user_uid конкретного сотрудника. " +
    "ФИО участников НЕ передаётся — только количество. " +
    "Требует настроенного подключения к 1С.",
    {
      user_uid: z.string().optional().describe(
        "ИдентификаторПользователяИБ (UUID) — вернуть только группы этого пользователя. " +
        "Получить UID можно через list_1c_users."
      ),
      group_name: z.string().optional().describe(
        "Фильтр по названию группы доступа (частичное совпадение)"
      ),
      include_roles: z.boolean().default(false).describe(
        "Включать список ролей профиля каждой группы (может увеличить ответ)"
      ),
      limit: z.number().int().min(1).max(200).default(50).describe(
        "Максимум групп в ответе (по умолчанию 50)"
      ),
    },
    onecTool(async ({ user_uid, group_name, include_roles, limit }) => {
      const result = await callOnecTool("get_access_groups", {
        user_uid: user_uid || "",
        group_name: group_name || "",
        include_roles: include_roles ? "true" : "false",
        limit,
      });
      return liveReply(unwrapOnecPayload(result));
    }, "Используйте onec_health для проверки подключения к 1С.")
  );

  // ── 15: execute_1c_query ───────────────────────────────────────────────────

  server.tool(
    "execute_1c_query",
    "Выполняет произвольный запрос к данным 1С через расширение. " +
    "Агент может запросить данные из любого справочника, регистра или документа " +
    "БИТ.ФИНАНС — например, сотрудников, ТМЦ, договоры, путевые листы. " +
    "ВАЖНО: запросы только на чтение (SELECT), изменение данных не поддерживается. " +
    "Требует настроенного подключения к 1С.",
    {
      query_text: z.string().describe(
        "Текст запроса на языке запросов 1С (СКД-совместимый синтаксис). " +
        "Например: 'ВЫБРАТЬ Наименование, ИНН ИЗ Справочник.Контрагенты ГДЕ ИНН ПОДОБНО \"7802%\"'"
      ),
      params: z.record(z.unknown()).optional().describe(
        "Параметры запроса в виде объекта {имяПараметра: значение}"
      ),
      limit: z.number().int().min(1).max(1000).default(100).describe(
        "Максимум строк результата (по умолчанию 100, максимум 1000)"
      ),
    },
    // Проверка read-only выполняется ВНУТРИ 1С (ПроверитьЗапросТолькоЧтение в BSL).
    // Дублирующая JS-проверка была удалена намеренно:
    //   1) BSL — единственная реальная граница доверия (там же подставляются params);
    //   2) BSL корректно вырезает строковые литералы, поэтому легитимный запрос
    //      ВЫБРАТЬ ... ГДЕ Комментарий = "Удалить после проверки" не отклоняется;
    //   3) два списка запрещённых слов неизбежно расходились при правках.
    onecTool(async ({ query_text, params, limit }) => {
      // Инструмент появляется в расширении не во всех версиях — если его нет,
      // сообщаем об этом явно, а не отдаём криптовую ошибку JSON-RPC.
      const available = await listOnecTools();
      const names = (available?.tools || []).map((t) => t.name);
      if (!names.includes("execute_query")) {
        return errorReply(
          "NotSupported",
          "Установленная версия расширения MCP_Сервер.cfe не содержит инструмент " +
          "execute_query. Обновите расширение в базе и перезапустите сеансы 1С.",
          {
            requested_query: query_text,
            onec_url: getOnecConfig().url,
            available_1c_tools: names,
            alternatives: [
              "get_visa_routes — визы, маршруты, права, шаги алгоритма, граф маршрута",
              "get_1c_metadata — список объектов и структура",
            ],
          }
        );
      }

      const result = await callOnecTool("execute_query", {
        query: query_text,
        query_text,
        params: params || {},
        limit,
      });

      return liveReply(unwrapOnecPayload(result), { query: query_text });
    }, "Проверьте синтаксис запроса. Используйте get_1c_metadata чтобы узнать " +
       "правильные имена таблиц и полей.")
  );

  // ── 16: get_1c_metadata ────────────────────────────────────────────────────

  server.tool(
    "get_1c_metadata",
    "Возвращает метаданные конфигурации 1С: список объектов (справочники, документы, " +
    "регистры и т.д.) с их реквизитами. Используйте перед execute_1c_query чтобы " +
    "узнать правильные имена таблиц и полей. Требует настроенного подключения к 1С.",
    {
      object_type: z.enum([
        "catalogs", "documents", "registers_accumulation",
        "registers_info", "registers_accounting", "all"
      ]).default("all").describe(
        "Тип объектов метаданных: catalogs (справочники), documents (документы), " +
        "registers_accumulation (регистры накопления), registers_info (регистры сведений), " +
        "registers_accounting (регистры бухгалтерии), all (все)"
      ),
      object_name: z.string().optional().describe(
        "Фильтр по имени объекта (частичное совпадение). " +
        "Например: 'Контрагент', 'ПутевойЛист', 'ГСМ'"
      ),
      include_attributes: z.boolean().default(false).describe(
        "Включать реквизиты объектов (по умолчанию false — только список объектов)"
      ),
      max_structures: z.number().int().min(1).max(30).default(10).describe(
        "Сколько объектов догружать со структурой при include_attributes=true (по умолчанию 10)"
      ),
    },
    async ({ object_type, object_name, include_attributes, max_structures }) => {
      try {
        // Расширение предоставляет два инструмента вместо одного get_metadata:
        //   list_metadata_objects  — список объектов по типу и маске имени
        //   get_metadata_structure — структура конкретного объекта (нужно точное имя)
        const TYPE_MAP = {
          catalogs:               ["Catalogs"],
          documents:              ["Documents"],
          registers_info:         ["InformationRegisters"],
          registers_accumulation: ["AccumulationRegisters"],
          registers_accounting:   ["AccountingRegisters"],
          all: ["Catalogs", "Documents", "InformationRegisters",
                "AccumulationRegisters", "AccountingRegisters"],
        };
        const metaTypes = TYPE_MAP[object_type] || TYPE_MAP.all;

        // Общий дедлайн на весь инструмент — иначе при object_type="all"
        // последовательные запросы могли суммарно превысить таймаут MCP-клиента.
        const DEADLINE_MS = Number(process.env.ONEC_TOOL_DEADLINE || 60_000);
        const deadline = Date.now() + DEADLINE_MS;
        const timeLeft = () => deadline - Date.now();

        // 1. Список объектов — все типы ПАРАЛЛЕЛЬНО (запросы независимы)
        const listResults = await Promise.all(
          metaTypes.map(async (metaType) => {
            try {
              const listed = await callOnecTool("list_metadata_objects", {
                metaType,
                nameMask: object_name || "",
                maxItems: 200,
              });
              const raw = unwrapOnecPayload(listed);
              const text = typeof raw === "string" ? raw : (raw?.raw ?? listed?.content?.[0]?.text ?? "");
              return { metaType, text: String(text), error: null };
            } catch (e) {
              return { metaType, text: "", error: e.message };
            }
          })
        );

        const objects = [];
        const listErrors = [];
        for (const { metaType, text, error } of listResults) {
          if (error) {
            listErrors.push({ meta_type: metaType, error });
            continue;
          }
          for (const line of text.split("\n").map((s) => s.trim()).filter(Boolean)) {
            // Формат строки: "Справочник.Контрагенты (Контрагенты)"
            const m = line.match(/^(\S+)\s*(?:\((.*)\))?$/);
            objects.push({
              meta_type: metaType,
              full_name: m ? m[1] : line,
              name: (m ? m[1] : line).split(".").pop(),
              synonym: m?.[2] ?? "",
            });
          }
        }

        // 2. При include_attributes догружаем структуры — тоже ПАРАЛЛЕЛЬНО
        let structures;
        let structuresTruncated = false;
        if (include_attributes && objects.length > 0) {
          const batch = objects.slice(0, max_structures);

          if (timeLeft() <= 0) {
            structures = [{
              note: "Дедлайн исчерпан на этапе получения списка — структуры не загружены. " +
                    "Уточните object_name или задайте object_type вместо 'all'.",
            }];
          } else {
            structures = await Promise.all(
              batch.map(async (obj) => {
                try {
                  const st = await callOnecTool("get_metadata_structure", {
                    metaType: obj.meta_type,
                    name: obj.name,
                  });
                  return {
                    full_name: obj.full_name,
                    structure: st?.content?.[0]?.text ?? st,
                  };
                } catch (e) {
                  return { full_name: obj.full_name, error: e.message };
                }
              })
            );

            if (objects.length > max_structures) {
              structuresTruncated = true;
              structures.push({
                note: `Структуры загружены только для первых ${max_structures} объектов из ${objects.length}. ` +
                      `Уточните object_name или увеличьте max_structures (до 30).`,
              });
            }
          }
        }

        return liveReply({
          object_type,
          filter: object_name || null,
          count: objects.length,
          objects,
          ...(structures ? { structures } : {}),
          ...(structuresTruncated ? { structures_truncated: true } : {}),
          ...(listErrors.length ? { list_errors: listErrors } : {}),
          elapsed_ms: DEADLINE_MS - timeLeft(),
        });
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: formatOnecError(err,
              "Используйте onec_health для проверки подключения к 1С."
            ),
          }],
        };
      }
    }
  );

  // ── 17: get_1c_documents ───────────────────────────────────────────────────

  server.tool(
    "get_1c_documents",
    "Получает документы из рабочей базы 1С:БИТ.ФИНАНС — путевые листы, " +
    "платёжные поручения, заявки на оплату, расходные ордера на ГСМ и т.д. " +
    "Возвращает универсальные поля шапки: номер, дата, проведён, пометка удаления, " +
    "тип документа, а также организация / контрагент / сумма — если такие реквизиты " +
    "есть у данного типа (см. fields_available в ответе). " +
    "Поддерживает фильтрацию по типу документа, периоду, статусу, контрагенту. " +
    "Требует настроенного подключения к 1С.",
    {
      document_type: z.string().describe(
        "Тип документа на языке метаданных 1С. Например: " +
        "'ПутевойЛист', 'бит_мат_ПутевойЛист', 'ЭлектронныйПутевойЛист'. " +
        "Принимается как 'ПутевойЛист', так и 'Документ.ПутевойЛист'. " +
        "Используйте get_1c_metadata для получения доступных типов."
      ),
      date_from: z.string().optional().describe(
        "Начальная дата периода в формате ГГГГ-ММ-ДД (например '2024-01-01')"
      ),
      date_to: z.string().optional().describe(
        "Конечная дата периода в формате ГГГГ-ММ-ДД (например '2024-12-31')"
      ),
      status: z.string().optional().describe(
        "Фильтр по статусу документа: 'Проведён', 'НеПроведён', 'Помечен'"
      ),
      counterparty: z.string().optional().describe(
        "Фильтр по контрагенту (частичное совпадение по наименованию)"
      ),
      limit: z.number().int().min(1).max(500).default(50).describe(
        "Максимум документов в ответе (по умолчанию 50)"
      ),
    },
    onecTool(async ({ document_type, date_from, date_to, status, counterparty, limit }) => {
      const result = await callOnecTool("get_documents", {
        document_type,
        date_from: date_from || "",
        date_to: date_to || "",
        status: status || "",
        counterparty: counterparty || "",
        limit,
      });
      return liveReply(unwrapOnecPayload(result), {
        document_type,
        filters: { date_from, date_to, status, counterparty },
      });
    }, "Используйте get_1c_metadata для уточнения имени типа документа, " +
       "или onec_health для проверки подключения.")
  );

  // ── 18: get_visa_routes ────────────────────────────────────────────────────

  server.tool(
    "get_visa_routes",
    "Получает актуальные данные по визам и маршрутам согласования из живой базы " +
    "1С:БИТ.ФИНАНС в реальном времени. " +
    "Режим visas — визы на документах с разбивкой по статусу (без ФИО, только должность). " +
    "Режим routes — маршруты согласования и шаги алгоритма с составом виз. " +
    "Режим rights — права установки виз (группы пользователей, без персональных данных); " +
    "поддерживает отбор по user_uid — какие визы может ставить конкретный сотрудник " +
    "лично и через свои группы. " +
    "Режим algorithm — шаги алгоритма процесса из справочника бит_АлгоритмыПроцессов. " +
    "Режим route_graph — БЛОК-СХЕМА маршрута: узлы и переходы алгоритма, " +
    "дополнительно возвращается готовая диаграмма Mermaid (flowchart). " +
    "Источники: РС.бит_УстановленныеВизы, РС.бит_ПраваУстановкиВиз, " +
    "Справочник.бит_Визы, Справочник.бит_АлгоритмыПроцессов, бит_ТочкиАлгоритмов.",
    {
      mode: z.enum(["visas", "routes", "rights", "algorithm", "route_graph"]).describe(
        "Режим выборки: " +
        "visas — визы на документах (статус, должность, маршрут, шаг алгоритма); " +
        "routes — уникальные маршруты с шагами алгоритма и составом виз; " +
        "rights — матрица прав: кто может устанавливать каждую визу (группы, без ФИО), " +
        "с необязательным отбором по user_uid; " +
        "algorithm — шаги алгоритма процесса; " +
        "route_graph — блок-схема маршрута (узлы + переходы + Mermaid-диаграмма)"
      ),
      visa_code: z.string().optional().describe(
        "Фильтр по визе из Справочник.бит_Визы. Ищется вхождение в НАИМЕНОВАНИЕ визы " +
        "(например 'Операционный директор', 'Главный механик'), либо точное совпадение " +
        "с ЛИТЕРОЙ (например 'ОД', 'РПО', 'НОАЗ'). " +
        "ВАЖНО: реквизит Кодификатор в базе не заполнен — фильтровать по коду вида 'V-01' нельзя."
      ),
      document_type: z.string().optional().describe(
        "Тип документа для фильтрации (часть имени или синонима, например 'ЦС-004', 'ПутевойЛист'). " +
        "В режимах visas/routes — фильтр по типу документа; " +
        "в режиме route_graph — поиск по наименованию алгоритма (например 'Заявка на затраты')."
      ),
      status_filter: z.enum(["active", "signed", "rejected", "all"]).default("all").describe(
        "Фильтр по статусу визы: active — только активные (ожидают подписи); " +
        "signed — подписанные; rejected — отклонённые; all — все (по умолчанию). " +
        "Применяется в режиме visas."
      ),
      date_from: z.string().optional().describe(
        "Дата начала периода в формате ГГГГ-ММ-ДД. Фильтр по дате установки визы."
      ),
      date_to: z.string().optional().describe(
        "Дата окончания периода в формате ГГГГ-ММ-ДД."
      ),
      algorithm_code: z.string().optional().describe(
        "Код алгоритма процесса для режимов algorithm и route_graph " +
        "(например 'БС-000753'). Если не указан — возвращает все алгоритмы."
      ),
      user_uid: z.string().optional().describe(
        "Отбор по сотруднику для режима rights: ИдентификаторПользователяИБ (UUID с дефисами), " +
        "например '490933bc-311e-41d5-bcc4-eeb4b996ebf5'. Получить UID: list_1c_users. " +
        "Отвечает на вопрос «какие визы может ставить этот сотрудник». " +
        "Без него возвращается вся матрица прав. ФИО не передаётся."
      ),
      include_groups: z.boolean().default(true).describe(
        "Учитывать ли права, полученные через группы пользователей, при отборе по user_uid. " +
        "true (по умолчанию) — персональные права и права групп сотрудника; " +
        "false — только персонально назначенные. " +
        "Права на визы обычно выдаются группам, поэтому false часто даёт пустой результат. " +
        "В ответе каждая строка помечена granted_via = direct | group."
      ),
      limit: z.number().int().min(1).max(200).default(50).describe(
        "Максимум строк в ответе (по умолчанию 50, максимум 200)."
      ),
    },
    onecTool(async ({ mode, visa_code, document_type, status_filter, date_from, date_to, algorithm_code, user_uid, include_groups, limit }) => {
      const result = await callOnecTool("get_visa_routes", {
        mode,
        visa_code:      visa_code      || "",
        document_type:  document_type  || "",
        status_filter:  status_filter  || "all",
        date_from:      date_from      || "",
        date_to:        date_to        || "",
        algorithm_code: algorithm_code || "",
        user_uid:       user_uid       || "",
        include_groups: include_groups === false ? "false" : "true",
        limit,
      });

      // Расширение возвращает JSON строкой внутри content[0].text — разбираем,
      // чтобы отдать агенту структуру, а не строку в строке.
      const payload = unwrapOnecPayload(result);

      // Для блок-схемы дополнительно рендерим Mermaid
      let diagrams;
      if (mode === "route_graph" && Array.isArray(payload?.graphs)) {
        diagrams = payload.graphs.map((g) => ({
          algorithm_code: g.algorithm_code,
          algorithm_name: g.algorithm_name,
          mermaid: renderRouteMermaid(g),
        }));
      }

      return liveReply(
        { ...payload, ...(diagrams ? { diagrams } : {}) },
        {
          mode,
          filters: {
            visa_code, document_type, status_filter, date_from, date_to, algorithm_code,
            ...(user_uid ? { user_uid, include_groups: include_groups !== false } : {}),
          },
        }
      );
    }, "Проверьте правильность параметров. " +
       "Используйте onec_health для диагностики подключения к 1С. " +
       "Убедитесь что расширение MCP_Сервер.cfe обновлено (содержит get_visa_routes).")
  );

  // ── 19: get_user_rights ────────────────────────────────────────────────────
  //
  // Возвращает группы доступа и профили пользователя по ссылке (user_ref).
  // Формат ссылки: 'Справочник.Пользователи?ref=<hex>'
  // ФИО и персональные данные НЕ передаются — только ссылка для поиска.
  //

  server.tool(
    "get_user_rights",
    "Получает группы доступа и профили пользователя 1С по ссылке (user_ref). " +
    "Формат ссылки: 'Справочник.Пользователи?ref=<hex>', " +
    "например 'Справочник.Пользователи?ref=8aa40050569b551b11f08de377fb12a5'. " +
    "ФИО и контактные данные НЕ передаются — только ссылка для анонимного поиска. " +
    "Показывает: к каким группам доступа относится пользователь, какой профиль у каждой группы, " +
    "опционально — виды доступа (ЦФО, склады, подразделения). " +
    "Требует настроенного подключения к 1С и расширения MCP_Сервер.cfe.",
    {
      user_ref: z.string().describe(
        "Ссылка на пользователя в формате 'Справочник.Пользователи?ref=<hex>'. " +
        "ФИО не передаётся — только ссылка для анонимного поиска в базе."
      ),
      include_access_values: z.enum(["true", "false"]).default("false").describe(
        "true — включать виды доступа группы (ЦФО, склады, подразделения) в ответ. По умолчанию false."
      ),
      limit: z.number().int().min(1).max(200).default(50).describe(
        "Максимум групп доступа в ответе (по умолчанию 50)."
      ),
    },
    onecTool(async ({ user_ref, include_access_values, limit }) => {
      const result = await callOnecTool("get_user_rights", {
        user_ref,
        include_access_values: include_access_values || "false",
        limit,
      });
      return liveReply(unwrapOnecPayload(result));
    }, "Проверьте формат user_ref: 'Справочник.Пользователи?ref=<hex>'. " +
       "hex — 32-символьный шестнадцатеричный идентификатор объекта в базе 1С.")
  );

  // ── 20: get_user_visas ──────────────────────────────────────────────────────
  //
  // Визы согласования пользователя через его группы доступа.
  // Принимает ИдентификаторПользователяИБ. Все вычисления внутри 1С.
  // ФИО не передаётся.
  //

  server.tool(
    "get_user_visas",
    "Возвращает визы согласования пользователя 1С через его группы доступа. " +
    "Принимает ИдентификаторПользователяИБ (UUID). Все вычисления внутри 1С — " +
    "ФИО и персональные данные НЕ передаются. " +
    "Показывает: название визы, литеру, условие назначения, замещаемого. " +
    "Требует настроенного подключения к 1С и расширения MCP_Сервер.cfe.",
    {
      user_uid: z.string().describe(
        "ИдентификаторПользователяИБ в формате UUID с дефисами. " +
        "Например: '490933bc-311e-41d5-bcc4-eeb4b996ebf5'. " +
        "ФИО не передаётся — только анонимный идентификатор."
      ),
    },
    onecTool(async ({ user_uid }) => {
      const result = await callOnecTool("get_user_visas", { user_uid });
      return liveReply(unwrapOnecPayload(result));
    }, "Проверьте формат user_uid: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'. " +
       "Получить UID: execute_1c_query → ВЫБРАТЬ ИдентификаторПользователяИБ " +
       "ИЗ Справочник.Пользователи ГДЕ Наименование ПОДОБНО '%Имя%'")
  );


  // ── 21: check_document_access ──────────────────────────────────────────────
  //
  // Самодиагностика прав: «каких прав мне не хватает для работы с документом».
  // Единственный инструмент живой базы, доступный роли user.
  //
  // Роль user всегда получает ответ про себя: параметр user_uid для неё
  // отклоняется, а без него расширение проверяет текущего пользователя сеанса
  // 1С — то есть владельца токена (запрос уходит под его доменной учёткой).
  // Так рядовой сотрудник не может составить карту прав коллег.
  //

  server.tool(
    "check_document_access",
    "Отвечает на вопрос «каких прав мне не хватает для работы с документом». " +
    "Проверяет права Чтение / Добавление / Изменение / Проведение / ПометкаУдаления " +
    "на указанный тип документа и возвращает по каждому признак наличия. " +
    "Для недостающих прав подбирает профили групп доступа, которые их дают — " +
    "именно такой профиль нужно запросить у администратора. " +
    "По умолчанию проверяются права того, кто задаёт вопрос. " +
    "ФИО и персональные данные не передаются.",
    {
      document_type: z.string().describe(
        "Тип документа на языке метаданных 1С. Например: 'бит_ЗаявкаНаРасходованиеСредств', " +
        "'ПутевойЛист'. Принимается как 'ПутевойЛист', так и 'Документ.ПутевойЛист'. " +
        "Точное имя типа подскажет администратор или инструкция по документу."
      ),
      user_uid: z.string().optional().describe(
        "ИдентификаторПользователяИБ проверяемого сотрудника (UUID с дефисами). " +
        "Только для ролей analyst и admin. Если не указан — проверяются права " +
        "текущего пользователя (того, чьим токеном выполнен вызов)."
      ),
      suggest_profiles: z.boolean().default(true).describe(
        "true (по умолчанию) — подобрать профили групп доступа для недостающих прав; " +
        "false — вернуть только перечень прав."
      ),
    },
    onecTool(async ({ document_type, user_uid, suggest_profiles }) => {
      const ctx = getCtx();

      // Диагностика чужих прав — привилегия. Проверка здесь, а не в BSL:
      // роль известна только MCP-серверу, в 1С уходит уже готовое решение.
      if (user_uid && ctx && !roleAtLeast(ctx.role, "analyst")) {
        audit(ctx, "check_document_access", {
          result: "denied",
          reason: "user_uid требует роль analyst",
        });
        return errorReply(
          "Forbidden",
          "Проверка прав другого сотрудника доступна ролям analyst и admin. " +
          `Ваша роль: '${ctx.role}'.`,
          {
            hint: "Вызовите инструмент без параметра user_uid — " +
                  "будут проверены ваши собственные права.",
          }
        );
      }

      const result = await callOnecTool("check_document_access", {
        document_type,
        user_uid: user_uid || "",
        suggest_profiles: suggest_profiles === false ? "false" : "true",
      });
      return liveReply(unwrapOnecPayload(result), { document_type });
    }, "Проверьте имя типа документа. " +
       "Убедитесь что расширение MCP_Сервер.cfe обновлено (содержит check_document_access).")
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 20: list_routes
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "list_routes",
    "Возвращает список доступных маршрутов согласования 1С:БИТ.ФИНАНС по организациям. " +
    "Показывает: организацию, тип документа, код маршрута, количество вариантов. " +
    "Используйте для получения доступных организаций и типов документов перед вызовом suggest_route.",
    {
      org: z.string().optional().describe(
        "Фильтр по организации/БЕ (частичное совпадение). Например: 'ГТИ', 'АФС', 'Ермаковское'. " +
        "Если не указан — возвращаются все организации."
      ),
    },
    async ({ org }) => {
      try {
        const result = listRoutes({ org });
        return {
          content: [{ type: "text", text: result.error
            ? JSON.stringify({ error: result.message }, null, 2)
            : result.formatted
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 21: suggest_route
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "suggest_route",
    "Подбирает цепочку согласования документа в 1С:БИТ.ФИНАНС по параметрам документа. " +
    "Возвращает последовательность шагов (Создание → Согласование → Утверждение) с конкретными ролями. " +
    "Роли с постфиксом 'БЕ' (например 'Генеральный директор БЕ') привязаны к указанной организации. " +
    "Реальные ФИО не хранятся — только роли/должности. " +
    "Перед вызовом используйте list_routes чтобы узнать доступные организации и типы документов.",
    {
      org: z.string().describe(
        "Организация/бизнес-единица. Например: 'ГТИ', 'АФС', 'Ермаковское'. " +
        "Поддерживается частичное совпадение по коду или полному наименованию."
      ),
      doc_type: z.string().describe(
        "Тип документа. Поддерживаются: 'ЦС-001' (Конкурентная карта), 'ЦС-002' (Заявка на МПЗ), " +
        "'ЦС-003' (Заявка на затраты), 'ЦС-004' (Заявка на расход ДС), " +
        "'ЦС-005' (Реестр платежей), 'ЦС-006' (Корректировка КВ), 'Заказ поставщику'. " +
        "Принимаются как коды (ЦС-001), так и названия ('Заявка на МПЗ')."
      ),
      amount: z.number().optional().describe(
        "Сумма документа в рублях. Влияет на пороговые условия согласования. " +
        "Например: 3000000 (3 млн руб.). Если не указать — пороги по сумме не применяются."
      ),
      cfo: z.string().optional().describe(
        "ЦФО (центр финансовой ответственности). Например: 'ГТИ-03ПО5 Месторождение Ермаковское', 'Закупки'. " +
        "Влияет на выбор согласующего по ЦФО."
      ),
      project: z.string().optional().describe(
        "Проект. Например: 'Ермаковское', 'Култума', 'Озерный', 'Лугокан'. " +
        "Также влияет на выбор варианта маршрута если для проекта есть отдельный вариант."
      ),
      operation_type: z.string().optional().describe(
        "Вид операции (для Заявки на расход ДС). Например: 'ОплатаПоставщику', " +
        "'ПеречислениеПодотчетномуЛицу', 'УплатаНалога', 'ВозвратПокупателю'."
      ),
      dds_article: z.string().optional().describe(
        "Статья ДДС. Например: '21102 НДФЛ', '212 Страховые взносы', '21918 Госпошлины и сборы прочие'."
      ),
      tk_type: z.string().optional().describe(
        "Тип тендерного комитета (для Конкурентной карты). Значения: 'ЗаочныйТК' или 'ОчныйТК'."
      ),
      responsible: z.string().optional().describe(
        "Ответственный в заказе (для Заказа поставщику). Например: 'ЗакупщикЛогистика', 'ЗакупщикБГК'."
      ),
    },
    async ({ org, doc_type, amount, cfo, project, operation_type, dds_article, tk_type, responsible }) => {
      try {
        const result = suggestRoute({ org, doc_type, amount, cfo, project, operation_type, dds_article, tk_type, responsible });
        return {
          content: [{ type: "text", text: result.error
            ? JSON.stringify({ error: result.message }, null, 2)
            : result.formatted
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 22: get_route
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_route",
    "Возвращает полное описание маршрута согласования — все варианты, все шаги, все условия — " +
    "для указанной организации и типа документа. " +
    "В отличие от suggest_route не фильтрует по параметрам, а показывает маршрут целиком. " +
    "Используйте для изучения структуры маршрута или его документирования.",
    {
      org: z.string().describe(
        "Организация/бизнес-единица. Например: 'ГТИ', 'АФС', 'Ермаковское'."
      ),
      doc_type: z.string().optional().describe(
        "Тип документа. Если не указан — возвращаются все маршруты организации. " +
        "Примеры: 'ЦС-002', 'Заявка на МПЗ', 'ЗаявкаНаМПЗ'."
      ),
    },
    async ({ org, doc_type }) => {
      try {
        const result = getRoute({ org, doc_type });
        return {
          content: [{ type: "text", text: result.error
            ? JSON.stringify({ error: result.message }, null, 2)
            : JSON.stringify(result, null, 2)
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 23: compare_routes
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "compare_routes",
    "Сравнивает маршруты согласования одного типа документа у двух разных организаций. " +
    "Показывает: общие роли, уникальные роли каждой организации, структуру шагов. " +
    "Пример: 'Чем отличается ЦС-002 у ГТИ от АФС?'",
    {
      org1: z.string().describe(
        "Первая организация. Например: 'ГТИ'."
      ),
      org2: z.string().describe(
        "Вторая организация. Например: 'АФС'."
      ),
      doc_type: z.string().describe(
        "Тип документа для сравнения. Примеры: 'ЦС-002', 'Заявка на МПЗ'."
      ),
    },
    async ({ org1, org2, doc_type }) => {
      try {
        const result = compareRoutes({ org1, org2, doc_type });
        return {
          content: [{ type: "text", text: result.error
            ? JSON.stringify({ error: result.message }, null, 2)
            : result.formatted
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 24: validate_route_params
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "validate_route_params",
    "Проверяет корректность параметров перед вызовом suggest_route. " +
    "Возвращает список ошибок (organization/doc_type не найдены) и предупреждений " +
    "(сумма не указана, нестандартный тип документа). " +
    "Используйте перед suggest_route если не уверены в корректности параметров.",
    {
      org: z.string().optional().describe("Организация для проверки."),
      doc_type: z.string().optional().describe("Тип документа для проверки."),
      amount: z.number().optional().describe("Сумма документа для проверки."),
    },
    async ({ org, doc_type, amount }) => {
      try {
        const result = validateRouteParams({ org, doc_type, amount });
        return {
          content: [{ type: "text", text: JSON.stringify({
            valid:      result.valid,
            issues:     result.issues,
            warnings:   result.warnings,
            normalized: result.normalized,
            summary:    result.formatted,
          }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }, null, 2) }] };
      }
    }
  );
}

// ── HTTP-сервер ───────────────────────────────────────────────────────────────

const app = express();

// Лимит тела запроса: без него один большой POST выедает память процесса.
app.use(express.json({ limit: "1mb" }));

// Авторизация по персональному токену.
//
// Токен принимается ТОЛЬКО из заголовка. Приём через ?token= убран:
// query-строка оседает в логах обратного прокси, в истории браузера
// и в заголовке Referer, то есть секрет утекает в места, которые никто не чистит.
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/") return next();

  const presented = req.headers["x-mcp-token"];
  const check = verifyToken(presented);

  if (!check.ok) {
    audit(null, "auth", {
      result: "denied",
      reason: check.reason,
      path: req.path,
      ip: req.ip,
    });
    return res.status(401).json({
      error: "Unauthorized",
      message: check.reason,
      hint: "Передайте персональный токен в заголовке X-MCP-Token. " +
            "За токеном обратитесь к администратору сервера.",
    });
  }

  // Контекст пользователя для обработчиков и журнала
  req.auth = {
    id: check.entry.id,
    login: check.entry.login,
    role: check.entry.role,
  };
  req.credentials = credentialsFor(check.entry);
  touchToken(check.entry.id);
  next();
});

// ── Горячая перезагрузка базы знаний ─────────────────────────────────────────

const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR
  || path.join(__dirname, "..", "knowledge", "instructions");

let reloadInProgress = false;
let lastReloadAt = null;

async function reloadKnowledgeBase(reason = "manual") {
  if (reloadInProgress) {
    log(`⏳ Перезагрузка уже выполняется, пропуск (${reason})`);
    return { skipped: true, reason: "already_in_progress" };
  }
  reloadInProgress = true;
  const start = Date.now();
  try {
    const docs = loadKnowledgeBase();   // из knowledge_base.js, возвращает полные объекты с tokens

    // Пустой каталог оставил бы систему в рассогласованном состоянии:
    // INSTRUCTION_DOCS уже пуст, а старый TF-IDF индекс ещё жив —
    // semantic-поиск возвращал бы результаты по несуществующим документам.
    if (docs.length === 0) {
      log(`⚠️  Перезагрузка (${reason}): каталог пуст, изменения не применены`);
      return {
        success: false,
        error: "Каталог инструкций пуст — перезагрузка отменена, старый индекс сохранён",
        docs_count: 0,
      };
    }

    // Пересчитываем TF-IDF индекс после загрузки (buildTfidfIndex также сбрасывает searchCache)
    buildTfidfIndex(docs);
    lastReloadAt = new Date().toISOString();
    const elapsed = Date.now() - start;
    const idxStats = getIndexStats();
    log(`✅ База знаний перезагружена (${reason}): ${docs.length} инструкций, vocab=${idxStats.vocab_size} за ${elapsed}ms`);

    // Сброс кэша маршрутов согласования
    try {
      reloadRoutesDb();
    } catch (err) {
      log(`⚠️  Не удалось перезагрузить routes_db.json: ${err.message}`);
    }

    return { success: true, docs_count: docs.length, elapsed_ms: elapsed, reloaded_at: lastReloadAt, index: idxStats };
  } catch (err) {
    log("❌ Ошибка перезагрузки базы знаний:", err.message);
    return { success: false, error: err.message };
  } finally {
    reloadInProgress = false;
  }
}

// Авто-перезагрузка при изменении .md файлов
let watchDebounceTimer = null;
try {
  fs.watch(KNOWLEDGE_DIR, { persistent: false }, (eventType, filename) => {
    if (!filename || !filename.endsWith(".md")) return;
    // Debounce: ждём 500ms после последнего события
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = setTimeout(() => {
      log(`📁 Изменён файл: ${filename} (${eventType}) — перезагружаю базу знаний...`);
      reloadKnowledgeBase(`fs.watch:${filename}`);
    }, 500);
  });
  log(`👁  Слежу за изменениями в ${KNOWLEDGE_DIR}`);
} catch (err) {
  log(`⚠️  fs.watch не удалось запустить: ${err.message}`);
}

// Горячая перезагрузка базы знаний — операция администратора.
// Токен уже проверен глобальным middleware выше, здесь остаётся только роль.
app.post("/reload", async (req, res) => {
  if (req.auth?.role !== "admin") {
    audit(req.auth, "reload", { result: "denied", reason: "требуется роль admin" });
    return res.status(403).json({
      error: "Forbidden",
      message: "Перезагрузка базы знаний доступна только роли admin",
    });
  }
  audit(req.auth, "reload", { result: "started" });
  const result = await reloadKnowledgeBase("POST /reload");
  res.json({
    ...result,
    knowledge_base: {
      instruction_docs: listInstructions().length,
      last_reload: lastReloadAt,
    },
  });
});

// Health-check.
//
// Эндпоинт открыт без токена — его опрашивает мониторинг. Поэтому здесь
// только признак живости: состав инструментов, число сессий, адрес базы и
// статус подключения к 1С раньше отдавались любому анониму, что давало
// разведданные для атаки. Подробности — в /status под admin-токеном.
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "gti-1c-mcp",
    version: SERVER_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// Подробное состояние — только для роли admin (токен проверен middleware).
app.get("/status", async (req, res) => {
  if (req.auth?.role !== "admin") {
    return res.status(403).json({
      error: "Forbidden",
      message: "Подробный статус доступен только роли admin",
    });
  }

  const onecHealth = await checkOnecHealth();
  const { tokens } = loadTokens();
  const now = new Date();

  res.json({
    status: "ok",
    server: "gti-1c-mcp",
    version: SERVER_VERSION,
    tools_count: TOOL_GROUPS_FLAT.length,
    tool_groups: TOOL_GROUPS,
    sessions: {
      active: sessions.size,
      max: MAX_SESSIONS,
      ttl_minutes: Math.round(SESSION_TTL_MS / 60000),
    },
    tokens: {
      total: tokens.length,
      active: tokens.filter((t) => !t.revoked && !(t.expires_at && new Date(t.expires_at) < now)).length,
      revoked: tokens.filter((t) => t.revoked).length,
    },
    knowledge_base: {
      loaded: true,
      instruction_docs: listInstructions().length,
      dir: "knowledge/instructions",
      last_reload: lastReloadAt,
    },
    tfidf_index: getIndexStats(),
    search_cache: getSearchCacheStats(),
    onec_connection: {
      configured: getOnecConfig().configured,
      url: getOnecConfig().url || null,
      status: onecHealth.ok ? "ok" : "unavailable",
      detail: onecHealth.detail,
    },
    timestamp: new Date().toISOString(),
  });
});

// Корень — краткая справка по подключению (без раскрытия состава инструментов)
app.get("/", (req, res) => {
  res.json({
    name: "gti-1c-mcp",
    version: SERVER_VERSION,
    mcp_endpoint: `http://HOST:${PORT}/mcp`,
    auth_header: "X-MCP-Token: <персональный токен>",
    docs: "Подключение: Remote MCP → URL /mcp, заголовок X-MCP-Token. " +
          "Токен выдаёт администратор сервера.",
  });
});

// ── Stateful Streamable HTTP (SDK 1.12+) ─────────────────────────────────────
// Каждая сессия — отдельный McpServer + StreamableHTTPServerTransport

const sessions = new Map(); // sessionId → { transport, lastActivity }

// Сессия держит отдельный экземпляр McpServer со всеми замыканиями инструментов.
// Раньше запись удалялась только по transport.onclose — при обрыве сети (kill
// процесса клиента, потеря соединения) она оставалась в Map навсегда.
const SESSION_TTL_MS   = Number(process.env.MCP_SESSION_TTL || 30 * 60_000); // 30 мин
const SESSION_SWEEP_MS = Number(process.env.MCP_SESSION_SWEEP || 5 * 60_000); // 5 мин
const MAX_SESSIONS     = Number(process.env.MCP_MAX_SESSIONS || 100);

function closeSession(sid, reason) {
  const entry = sessions.get(sid);
  if (!entry) return;
  sessions.delete(sid);
  try {
    entry.transport.close?.();
  } catch (err) {
    log(`⚠️  Ошибка закрытия сессии ${sid}: ${err.message}`);
  }
  log(`🧹 Сессия ${sid} закрыта (${reason}), активных: ${sessions.size}`);
}

// Периодическая чистка протухших сессий
const sessionSweeper = setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of sessions) {
    if (now - entry.lastActivity > SESSION_TTL_MS) {
      closeSession(sid, `неактивна >${Math.round(SESSION_TTL_MS / 60000)} мин`);
    }
  }
}, SESSION_SWEEP_MS);
sessionSweeper.unref?.(); // не держим event loop открытым из-за таймера

app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    // Переиспользуем существующую сессию
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId);

      // Сессия принадлежит выдавшему её токену. Без этой проверки другой
      // пользователь, узнав id сессии, работал бы с правами её владельца.
      if (entry.auth.id !== req.auth.id) {
        audit(req.auth, "session", {
          result: "denied",
          reason: "сессия принадлежит другому токену",
        });
        return res.status(403).json({
          error: "Forbidden",
          message: "Сессия принадлежит другому пользователю",
        });
      }

      entry.lastActivity = Date.now();
      // Запрос к 1С уходит под доменной учёткой владельца сессии
      await withCredentials(req.credentials, () =>
        entry.transport.handleRequest(req, res, req.body)
      );
      return;
    }

    // Новая сессия — только POST
    if (req.method !== "POST") {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad request: use POST for new sessions" },
        id: null,
      });
      return;
    }

    // Защита от неограниченного роста: вытесняем самую старую сессию
    if (sessions.size >= MAX_SESSIONS) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [sid, entry] of sessions) {
        if (entry.lastActivity < oldestAt) { oldestAt = entry.lastActivity; oldestId = sid; }
      }
      if (oldestId) closeSession(oldestId, `достигнут лимит ${MAX_SESSIONS} сессий`);
    }

    // Создаём транспорт
    const auth = req.auth;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastActivity: Date.now(), auth });
        audit(auth, "session", { result: "opened", session: id });
      },
    });

    // Удаляем сессию при штатном закрытии
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    // Создаём McpServer и регистрируем инструменты
    const server = new McpServer({
      name: "gti-1c-mcp",
      version: "1.0.0",
    });
    // Сервер живёт столько же, сколько сессия, поэтому владелец у него один
    registerTools(server, () => auth);
    await server.connect(transport);

    await withCredentials(req.credentials, () =>
      transport.handleRequest(req, res, req.body)
    );
  } catch (err) {
    log("MCP handler error:", err.message || String(err));
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: err.message },
        id: null,
      });
    }
  }
});

// ── Запуск ────────────────────────────────────────────────────────────────────

/**
 * Полная инициализация базы знаний — вызывается ровно один раз при старте.
 *
 * Синхронно:
 *   1. loadKnowledgeBase()   — читает .md файлы, стеммирует токены
 *   2. buildTfidfIndex(docs) — строит TF-IDF индекс
 *
 * Асинхронно в фоне (не блокирует старт):
 *   3. reloadRoutesDb()      — разбирает routes_db.json в память
 */
function initAll() {
  // ── 1+2: KB + TF-IDF (синхронно, один вызов loadKnowledgeBase) ──
  let tfidfStats = null;
  const t0 = Date.now();
  try {
    const allDocs = loadKnowledgeBase();
    if (allDocs.length === 0) {
      log(`⚠️  База знаний пуста — проверьте каталог knowledge/instructions`);
    } else {
      buildTfidfIndex(allDocs);
      tfidfStats = getIndexStats();
      log(`📚 База знаний: ${allDocs.length} инструкций, индекс за ${Date.now() - t0}мс`);
    }
  } catch (err) {
    log(`⚠️  TF-IDF индекс не построен: ${err.message}`);
  }

  // ── 3: Routes DB — предзагружаем в фоне через setImmediate ──────
  setImmediate(() => {
    try {
      reloadRoutesDb();
    } catch (err) {
      log(`⚠️  Routes DB не загружена: ${err.message}`);
    }
  });

  return tfidfStats;
}

// ── Выбор транспорта ─────────────────────────────────────────────────────────
//
// Режим задаётся явно флагом --stdio (или MCP_TRANSPORT=stdio), а не угадывается
// по process.stdin.isTTY. Прежняя эвристика ломалась при любом запуске без
// терминала — служба Windows, nohup, Start-Process, запуск из CI: stdin не TTY,
// сервер молча уходил в stdio-режим и HTTP-порт не слушал.
//
//   node src/server.js            → HTTP (по умолчанию)
//   node src/server.js --stdio    → stdio (для локальных MCP-клиентов)

const useStdio = process.argv.includes("--stdio")
  || process.env.MCP_TRANSPORT === "stdio";

if (useStdio) {
  // Инициализация ДО connect(): пока идёт чтение и стемминг 1.5 МБ,
  // клиент не должен получать ответы по неготовому индексу.
  const stats = initAll();

  const server = new McpServer({
    name: "gti-1c-mcp",
    version: "1.0.0",
  });
  registerTools(server);

  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    process.stderr.write(
      `[gti-1c-mcp] stdio-режим запущен. ` +
      `Инструкций: ${listInstructions().length}` +
      `${stats ? `, TF-IDF: ${stats.docs_count} doc` : ""}\n`
    );
  }).catch((err) => {
    process.stderr.write(`[gti-1c-mcp] Ошибка запуска stdio: ${err.message}\n`);
    process.exit(1);
  });

} else {
  // ── Режим HTTP (для ручного запуска, Docker, remote-подключений) ────────────
  //
  // initAll() вызывается ДО app.listen(). Раньше он стоял внутри колбэка listen:
  // порт уже принимал соединения, но event loop был заблокирован чтением и
  // стеммингом 1.5 МБ (~450 мс) — все входящие запросы висели в очереди.
  const stats = initAll();

  app.listen(PORT, () => {
    log(`✅ gti-1c-mcp запущен на порту ${PORT}`);
    log(`   MCP endpoint : http://localhost:${PORT}/mcp`);
    log(`   Health-check : http://localhost:${PORT}/health`);
    log(`   Инструментов : ${TOOL_GROUPS_FLAT.length}`);
    if (stats) log(`   TF-IDF индекс: ${stats.docs_count} doc, vocab=${stats.vocab_size}`);
    log(`   Инструкций   : ${listInstructions().length}`);

    // Значения токенов не логируем — в журнал идёт только их количество.
    const { tokens } = loadTokens();
    const now = new Date();
    const active = tokens.filter(
      (t) => !t.revoked && !(t.expires_at && new Date(t.expires_at) < now)
    );
    log(`   Токенов      : ${active.length} активных из ${tokens.length}` +
        ` (admin: ${active.filter((t) => t.role === "admin").length})`);
    if (tokens.length === 0) {
      log("   ⚠️  Токенов нет — сервер никого не пустит.");
      log('      Выдать: node --env-file=.env tools/token.mjs issue --login "HG\\Логин"');
    }
  });
}
