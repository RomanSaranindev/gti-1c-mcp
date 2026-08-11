/**
 * gti-1c-mcp — MCP-сервер
 *
 * Транспорт: Streamable HTTP (stateful, SDK 1.12+)
 * Порт: 3031 (по умолчанию)
 *
 * Инструменты (12):
 *
 * База знаний инструкций 1С.БИТ:
 *   1. list_instructions           — список всех инструкций (с фильтрами по коду/ключевому слову)
 *   2. search_instructions         — полнотекстовый поиск по базе знаний
 *   3. get_instruction             — полный текст инструкции по id или коду (ИП-301 и т.д.)
 *   4. semantic_search_instructions — TF-IDF + cosine similarity поиск (семантический)
 *
 * Профили доступа и матрица ролей RBAC:
 *   4. suggest_access_profile  — keyword-подбор профиля группы доступа (без LLM)
 *   5. get_roles_matrix        — полная матрица ролей RBAC
 *   6. validate_roles          — проверка корректности набора ролей
 *   7. get_approval_level      — уровень согласования по набору ролей
 *
 * Маппинг должность → профили (обезличенные данные сотрудников):
 *   8. suggest_profile_by_job  — типовые профили по названию должности (417 должностей)
 *   9. list_jobs               — список должностей из базы данных
 *
 * Объяснение и поиск по ролям:
 *  10. explain_profile        — объяснение профиля на языке бизнеса
 *  11. search_by_role         — поиск профилей и бизнес-функций по роли 1С
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  RBAC_MATRIX,
  ACCESS_PROFILES,
  suggestProfile,
  suggestProfiles,
} from "./rbac_matrix.js";

import {
  JOB_PROFILES_MAP,
  findJobs,
  getJobProfiles,
  suggestByJobQuery,
} from "./job_profiles.js";

import {
  loadKnowledgeBase,
  listInstructions,
  searchInstructions,
  getInstruction,
} from "./knowledge_base.js";

import {
  buildTfidfIndex,
  tfidfSearch,
  getIndexStats,
} from "./vector_search.js";

// ── Конфигурация ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || process.env.MCP_PORT || "3031");
const API_TOKEN = process.env.MCP_API_TOKEN || "gti-mcp-token-2024";

if (!process.env.MCP_API_TOKEN) {
  console.warn(
    "⚠️  MCP_API_TOKEN не задан — используется токен по умолчанию. " +
    "Смените переменную окружения перед публичным деплоем!"
  );
}

// ── Регистрация инструментов ──────────────────────────────────────────────────

function registerTools(server) {

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 1: list_instructions
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "list_instructions",
    "Возвращает список инструкций пользователя 1С.БИТ, загруженных в базу знаний MCP сервера. " +
    "Каждая инструкция имеет id, код (ИП-XXX), название и источник.",
    {
      filter_code: z.string().optional().describe("Фильтр по коду инструкции, например 'ИП-301'"),
      filter_keyword: z.string().optional().describe("Фильтр по ключевому слову в названии"),
    },
    async ({ filter_code, filter_keyword }) => {
      let docs = listInstructions();

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
            (d.code || "").toLowerCase().includes(kw)
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ total: docs.length, instructions: docs }, null, 2),
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 2: search_instructions
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "search_instructions",
    "Ищет инструкции пользователя 1С.БИТ по ключевым словам (полнотекстовый поиск по базе знаний). " +
    "Возвращает релевантные инструкции с оценкой соответствия. " +
    "Используйте для ответа на вопросы 'как сформировать...', 'где найти...', 'как заполнить...' в 1С.БИТ.",
    {
      query: z.string().describe(
        "Поисковый запрос, например 'путевой лист', 'приходный ордер от поставщика', 'поправочные коэффициенты ГСМ'"
      ),
      limit: z.number().int().min(1).max(20).default(5).describe(
        "Максимум результатов (по умолчанию 5)"
      ),
    },
    async ({ query, limit }) => {
      const result = searchInstructions(query, { limit });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
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
  // ИНСТРУМЕНТ 4: semantic_search_instructions (TF-IDF + cosine)
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "semantic_search_instructions",
    "Семантический поиск по инструкциям 1С.БИТ на основе TF-IDF + косинусного сходства. " +
    "Понимает смысловые запросы лучше, чем keyword-поиск: находит документы по близким понятиям. " +
    "Например: 'как оформить расход топлива' найдёт инструкции по заправке и ведомостям ГСМ.",
    {
      query: z.string().describe(
        "Поисковый запрос на естественном языке. Например: " +
        "'как оформить командировку', 'расход топлива диспетчер', 'согласование платежа'"
      ),
      limit: z.number().int().min(1).max(20).default(5).describe(
        "Максимум результатов (по умолчанию 5)"
      ),
      min_score: z.number().min(0).max(1).default(0.01).describe(
        "Минимальный порог релевантности (0.0–1.0, по умолчанию 0.01)"
      ),
    },
    async ({ query, limit, min_score }) => {
      const stats = getIndexStats();
      if (!stats.ready) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "TF-IDF индекс не готов. Попробуйте через несколько секунд после старта сервера.",
              fallback: "Используйте search_instructions для keyword-поиска.",
            }, null, 2),
          }],
        };
      }
      const result = tfidfSearch(query, { limit, minScore: min_score });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...result,
            index_stats: stats,
          }, null, 2),
        }],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ИНСТРУМЕНТ 5: suggest_access_profile (нумерация сдвинута)
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "suggest_access_profile",
    "Подбирает профиль(и) группы доступа 1С:БИТ.ФИНАНС по описанию задач сотрудника " +
    "(без LLM, по ключевым словам). " +
    "Режим 'single' — один лучший профиль. " +
    "Режим 'multi' — все подходящие профили (для должностей с несколькими профилями, например кладовщик).",
    {
      request_text: z.string().describe(
        "Описание задач или функций сотрудника. " +
        "Например: 'кладовщик — заявки на МПЗ, складские документы, приходные и расходные ордера'"
      ),
      mode: z.enum(["single", "multi"]).default("single").describe(
        "'single' — вернуть один наилучший профиль (по умолчанию). " +
        "'multi' — вернуть все подходящие профили."
      ),
    },
    async ({ request_text, mode }) => {
      const approvalNote = (p) =>
        p.requires_chief_accountant && p.requires_transport_head
          ? "Требуется согласование: руководитель + главный бухгалтер + руководитель АТ"
          : p.requires_chief_accountant
          ? "Требуется согласование: руководитель + главный бухгалтер"
          : p.requires_transport_head
          ? "Требуется согласование: руководитель + руководитель АТ"
          : "Стандартное согласование: только линейный руководитель";

      // ── Режим multi ────────────────────────────────────────────────────────
      if (mode === "multi") {
        const all = suggestProfiles(request_text);

        if (all.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    result: null,
                    message: "Не удалось подобрать профили. Уточните описание задач.",
                    available_profiles: ACCESS_PROFILES.map((p) => ({
                      id: p.id,
                      name: p.name,
                      description: p.description,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const needsChief = all.some((r) => r.profile.requires_chief_accountant);
        const needsTransport = all.some((r) => r.profile.requires_transport_head);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  mode: "multi",
                  total_profiles: all.length,
                  recommended_profiles: all.map((r) => ({
                    id: r.profile.id,
                    name: r.profile.name,
                    description: r.profile.description,
                    key_roles: r.profile.key_roles,
                    requires_chief_accountant: r.profile.requires_chief_accountant,
                    requires_transport_head: r.profile.requires_transport_head,
                    match_score: r.score,
                    explanation: r.explanation,
                  })),
                  approval_summary: {
                    requires_chief_accountant: needsChief,
                    requires_transport_head: needsTransport,
                    approval_note:
                      needsChief && needsTransport
                        ? "Требуется согласование: руководитель + главный бухгалтер + руководитель АТ"
                        : needsChief
                        ? "Требуется согласование: руководитель + главный бухгалтер"
                        : needsTransport
                        ? "Требуется согласование: руководитель + руководитель АТ"
                        : "Стандартное согласование: только линейный руководитель",
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ── Режим single ───────────────────────────────────────────────────────
      const { profile, score, explanation } = suggestProfile(request_text);

      if (!profile || score === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  result: null,
                  message: "Не удалось подобрать профиль. Уточните описание задач.",
                  available_profiles: ACCESS_PROFILES.map((p) => ({
                    id: p.id,
                    name: p.name,
                    description: p.description,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                mode: "single",
                recommended_profile: {
                  id: profile.id,
                  name: profile.name,
                  description: profile.description,
                  key_roles: profile.key_roles,
                  requires_chief_accountant: profile.requires_chief_accountant,
                  requires_transport_head: profile.requires_transport_head,
                },
                match_score: score,
                explanation,
                approval_note: approvalNote(profile),
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
  // ИНСТРУМЕНТ 5: get_roles_matrix
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_roles_matrix",
    "Возвращает полную матрицу ролей RBAC для 1С:БИТ.ФИНАНС. " +
    "Используйте для изучения доступных бизнес-функций и их маппинга на роли 1С.",
    {
      filter_requires_accounting: z.boolean().optional().describe(
        "Если true — только роли, требующие согласования главбуха"
      ),
      filter_requires_transport: z.boolean().optional().describe(
        "Если true — только роли, требующие согласования рук. АТ"
      ),
      search_keyword: z.string().optional().describe("Фильтр по ключевому слову"),
    },
    async ({ filter_requires_accounting, filter_requires_transport, search_keyword }) => {
      let functions = RBAC_MATRIX.business_functions;

      if (filter_requires_accounting) functions = functions.filter((f) => f.requires_chief_accountant);
      if (filter_requires_transport) functions = functions.filter((f) => f.requires_transport_head);
      if (search_keyword) {
        const kw = search_keyword.toLowerCase();
        functions = functions.filter(
          (f) =>
            f.display_name.toLowerCase().includes(kw) ||
            f.description.toLowerCase().includes(kw) ||
            f.keywords.some((k) => k.toLowerCase().includes(kw))
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total_functions: functions.length,
                mandatory_roles: RBAC_MATRIX.mandatory_roles,
                business_functions: functions,
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
  // ИНСТРУМЕНТ 6: validate_roles
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "validate_roles",
    "Проверяет корректность набора ролей 1С: какие роли существуют в матрице, " +
    "какие не найдены, и рекомендует обязательные роли.",
    {
      roles: z.array(z.string()).describe("Массив наименований ролей для проверки"),
    },
    async ({ roles }) => {
      const knownRoles = new Set();
      RBAC_MATRIX.mandatory_roles.roles.forEach((r) => knownRoles.add(r));
      RBAC_MATRIX.business_functions.forEach((f) => f.roles.forEach((r) => knownRoles.add(r)));

      const found = roles.filter((r) => knownRoles.has(r));
      const notFound = roles.filter((r) => !knownRoles.has(r));
      const missing = RBAC_MATRIX.mandatory_roles.roles.filter((r) => !roles.includes(r));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total_checked: roles.length,
                found_in_matrix: found,
                not_found_in_matrix: notFound,
                missing_mandatory: missing,
                is_valid: notFound.length === 0 && missing.length === 0,
                recommendations:
                  missing.length > 0
                    ? `Добавьте обязательные роли: ${missing.join(", ")}`
                    : "Набор ролей корректен.",
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
  // ИНСТРУМЕНТ 8: suggest_profile_by_job
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "suggest_profile_by_job",
    "Подбирает типовые профили доступа 1С по названию должности сотрудника. " +
    "Использует реальные обезличенные данные из базы сотрудников (417 должностей). " +
    "Возвращает профили, которые встречаются у >= 40% сотрудников данной должности, " +
    "с указанием % охвата и количества сотрудников. " +
    "Поддерживает нечёткий поиск по подстроке названия должности.",
    {
      job_title: z.string().describe(
        "Название должности сотрудника. Например: 'кладовщик', 'бухгалтер', 'механик', 'диспетчер'. " +
        "Поддерживается частичное совпадение."
      ),
      min_pct: z.number().min(0).max(100).default(40).describe(
        "Минимальный % сотрудников данной должности, у которых должен быть профиль (по умолчанию 40%)"
      ),
      limit: z.number().int().min(1).max(50).default(20).describe(
        "Максимальное количество профилей в ответе (по умолчанию 20)"
      ),
    },
    async ({ job_title, min_pct, limit }) => {
      // Точное совпадение
      let exactData = getJobProfiles(job_title);
      let matchedJob = exactData ? job_title : null;
      let allMatches = [];

      if (!exactData) {
        // Нечёткий поиск по подстроке
        const result = suggestByJobQuery(job_title);
        if (result) {
          matchedJob = result.job;
          exactData = result.data;
          allMatches = result.all_matches || [];
        }
      } else {
        allMatches = [job_title];
      }

      if (!exactData) {
        // Совпадений нет — вернём близкие варианты
        const similar = findJobs(job_title).slice(0, 10);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  result: null,
                  message: `Должность '${job_title}' не найдена в базе данных.`,
                  hint: "Уточните название должности. Доступные похожие варианты:",
                  similar_jobs: similar,
                  total_jobs_in_db: Object.keys(JOB_PROFILES_MAP).length,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Фильтрация по min_pct
      const filtered = exactData.typical_profiles
        .filter((p) => p.pct >= min_pct)
        .slice(0, limit);

      const otherMatches = allMatches.filter((j) => j !== matchedJob).slice(0, 5);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                matched_job: matchedJob,
                total_persons_in_db: exactData.total_persons,
                min_pct_filter: min_pct,
                profiles_count: filtered.length,
                typical_profiles: filtered.map((p) => ({
                  profile: p.profile,
                  coverage_pct: p.pct,
                  persons_count: p.count,
                })),
                note:
                  filtered.length === 0
                    ? `Нет профилей с охватом >= ${min_pct}%. Уменьшите min_pct.`
                    : `Профили встречаются у >= ${min_pct}% сотрудников данной должности.`,
                other_similar_jobs:
                  otherMatches.length > 0
                    ? otherMatches
                    : undefined,
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
  // ИНСТРУМЕНТ 9: list_jobs
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "list_jobs",
    "Возвращает список должностей из базы данных сотрудников (417 должностей). " +
    "Поддерживает фильтрацию по подстроке. Помогает найти точное название должности " +
    "перед вызовом suggest_profile_by_job.",
    {
      filter: z.string().optional().describe(
        "Подстрока для фильтрации должностей. Например: 'бухгалтер', 'начальник', 'инженер'"
      ),
      limit: z.number().int().min(1).max(200).default(50).describe(
        "Максимальное количество должностей в ответе"
      ),
    },
    async ({ filter, limit }) => {
      let jobs = Object.entries(JOB_PROFILES_MAP).map(([job, data]) => ({
        job_title: job,
        total_persons: data.total_persons,
        typical_profiles_count: data.typical_profiles.filter((p) => p.pct >= 40).length,
      }));

      if (filter) {
        const q = filter.toLowerCase();
        jobs = jobs.filter((j) => j.job_title.toLowerCase().includes(q));
      }

      // Сортируем по числу сотрудников (самые частые — вверх)
      jobs.sort((a, b) => b.total_persons - a.total_persons);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total_found: jobs.length,
                filter: filter || null,
                jobs: jobs.slice(0, limit),
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
  // ИНСТРУМЕНТ 7: get_approval_level
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_approval_level",
    "Определяет уровень согласования для набора ролей: " +
    "standard (руководитель), accounting (+главбух), transport (+нач. АТ), transport_accounting (+оба).",
    {
      roles: z.array(z.string()).describe("Массив наименований ролей 1С"),
    },
    async ({ roles }) => {
      let requiresAccounting = false;
      let requiresTransport = false;
      const matchedFunctions = [];

      for (const func of RBAC_MATRIX.business_functions) {
        if (func.roles.some((r) => roles.includes(r))) {
          matchedFunctions.push(func.display_name);
          if (func.requires_chief_accountant) requiresAccounting = true;
          if (func.requires_transport_head) requiresTransport = true;
        }
      }

      const level =
        requiresAccounting && requiresTransport
          ? "transport_accounting"
          : requiresAccounting
          ? "accounting"
          : requiresTransport
          ? "transport"
          : "standard";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                approval_level: level,
                requires_chief_accountant: requiresAccounting,
                requires_transport_head: requiresTransport,
                approvers_required: [
                  "Линейный руководитель (всегда обязателен)",
                  ...(requiresAccounting ? ["Главный бухгалтер (есть роли БУ/НУ)"] : []),
                  ...(requiresTransport ? ["Руководитель отдела АТ (есть транспортные роли)"] : []),
                ],
                matched_business_functions: matchedFunctions,
                description: {
                  standard: "Только линейный руководитель",
                  accounting: "Руководитель + Главный бухгалтер",
                  transport: "Руководитель + Руководитель АТ",
                  transport_accounting: "Руководитель + Главный бухгалтер + Руководитель АТ",
                }[level],
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
  // ИНСТРУМЕНТ 10: explain_profile
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "explain_profile",
    "Объясняет профиль доступа 1С на языке бизнеса: что сотрудник сможет делать, " +
    "какие разделы программы будут доступны, какое согласование требуется. " +
    "Принимает id или название профиля.",
    {
      profile_id: z.string().describe(
        "id профиля из ACCESS_PROFILES (например PROFILE_КЛАДОВЩИК) или часть названия (нечёткий поиск)"
      ),
    },
    async ({ profile_id }) => {
      // 1. Поиск профиля — сначала точное совпадение по id, потом нечёткое по name
      const query = profile_id.toLowerCase();
      let profile =
        ACCESS_PROFILES.find((p) => p.id === profile_id) ||
        ACCESS_PROFILES.find((p) => p.id.toLowerCase() === query) ||
        ACCESS_PROFILES.find((p) => p.name.toLowerCase() === query) ||
        ACCESS_PROFILES.find((p) => p.name.toLowerCase().includes(query));

      if (!profile) {
        // Топ-5 похожих: те, у кого name или id содержат хоть часть слов из запроса
        const words = query.split(/[\s_\-\.]+/).filter(Boolean);
        const scored = ACCESS_PROFILES.map((p) => {
          const hay = (p.id + " " + p.name + " " + p.description).toLowerCase();
          const hits = words.filter((w) => hay.includes(w)).length;
          return { id: p.id, name: p.name, hits };
        })
          .filter((x) => x.hits > 0)
          .sort((a, b) => b.hits - a.hits)
          .slice(0, 5);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Профиль не найден",
                  profile_id,
                  similar_profiles: scored.map((x) => ({ id: x.id, name: x.name })),
                  hint: "Уточните id или название профиля. Используйте suggest_access_profile для подбора.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // 2. Найти связанные бизнес-функции через key_roles профиля
      const profileRolesSet = new Set(profile.key_roles.map((r) => r.toLowerCase()));
      const matchedFunctions = RBAC_MATRIX.business_functions.filter((bf) =>
        bf.roles.some((r) => profileRolesSet.has(r.toLowerCase()))
      );

      // 3. Также учесть business_function_ids если есть
      if (profile.business_function_ids && profile.business_function_ids.length > 0) {
        const bfIdSet = new Set(profile.business_function_ids);
        for (const bf of RBAC_MATRIX.business_functions) {
          if (bfIdSet.has(bf.id) && !matchedFunctions.find((f) => f.id === bf.id)) {
            matchedFunctions.push(bf);
          }
        }
      }

      // 4. can_do — из description найденных бизнес-функций + description профиля
      const canDo = [];
      // Разбиваем description профиля на пункты (по запятой, точке с запятой, скобкам)
      const profileDesc = profile.description || "";
      if (profileDesc && profileDesc !== profile.name) {
        const parts = profileDesc
          .split(/[;,]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 3);
        if (parts.length > 1) {
          canDo.push(...parts);
        } else {
          canDo.push(profileDesc);
        }
      }
      for (const bf of matchedFunctions) {
        if (bf.description && !canDo.some((c) => c === bf.description)) {
          canDo.push(bf.description);
        }
      }

      // 5. accessible_sections — уникальные keywords из найденных бизнес-функций (первые 6)
      const allKeywords = [];
      for (const bf of matchedFunctions) {
        for (const kw of bf.keywords) {
          if (!allKeywords.includes(kw)) allKeywords.push(kw);
        }
      }
      const accessibleSections = allKeywords.slice(0, 6);

      // 6. approval
      const requiresAccounting = profile.requires_chief_accountant;
      const requiresTransport = profile.requires_transport_head;
      const approvalLevel =
        requiresAccounting && requiresTransport
          ? "transport_accounting"
          : requiresAccounting
          ? "accounting"
          : requiresTransport
          ? "transport"
          : "standard";
      const approvers = ["Линейный руководитель (всегда)"];
      if (requiresAccounting) approvers.push("Главный бухгалтер");
      if (requiresTransport) approvers.push("Руководитель отдела АТ");
      const approvalNote =
        approvalLevel === "transport_accounting"
          ? "Требуется согласование руководителя, главного бухгалтера и руководителя АТ"
          : approvalLevel === "accounting"
          ? "Требуется согласование руководителя и главного бухгалтера"
          : approvalLevel === "transport"
          ? "Требуется согласование руководителя и руководителя АТ"
          : "Стандартное согласование — только линейный руководитель";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                profile: {
                  id: profile.id,
                  name: profile.name,
                  description: profile.description,
                },
                can_do: canDo,
                accessible_sections: accessibleSections,
                approval: {
                  level: approvalLevel,
                  approvers,
                  note: approvalNote,
                },
                key_roles_count: profile.key_roles.length,
                matched_business_functions: matchedFunctions.map((bf) => bf.display_name),
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
  // ИНСТРУМЕНТ 11: search_by_role
  // ═══════════════════════════════════════════════════════════════════════════

  server.tool(
    "search_by_role",
    "Находит профили доступа и бизнес-функции 1С по конкретному названию роли " +
    "(например 'бит_ИсполнительКазначейства'). Полезно для администраторов 1С, " +
    "которые видят роль в базе и хотят понять к какому профилю она относится.",
    {
      role_name: z.string().describe(
        "Название роли 1С (полное или частичное, case-insensitive). Например: 'бит_Казначей', 'гти_ДопПраваСклада'"
      ),
    },
    async ({ role_name }) => {
      const query = role_name.toLowerCase();

      // 1. Поиск в business_functions
      const foundInFunctions = [];
      for (const bf of RBAC_MATRIX.business_functions) {
        const matched = bf.roles.find((r) => r.toLowerCase().includes(query));
        if (matched) {
          foundInFunctions.push({
            id: bf.id,
            display_name: bf.display_name,
            description: bf.description,
            requires_chief_accountant: bf.requires_chief_accountant,
            requires_transport_head: bf.requires_transport_head,
            matched_role: matched,
          });
        }
      }

      // 2. Поиск в ACCESS_PROFILES по key_roles
      const foundInProfiles = [];
      for (const p of ACCESS_PROFILES) {
        const matched = p.key_roles.find((r) => r.toLowerCase().includes(query));
        if (matched) {
          foundInProfiles.push({
            id: p.id,
            name: p.name,
            matched_role: matched,
            requires_chief_accountant: p.requires_chief_accountant,
            requires_transport_head: p.requires_transport_head,
          });
        }
      }

      // 3. Поиск в mandatory_roles
      const isMandatory = RBAC_MATRIX.mandatory_roles.roles.some((r) =>
        r.toLowerCase().includes(query)
      );

      // 4. Определить уровень согласования по найденным функциям
      const requiresAccounting = foundInFunctions.some((f) => f.requires_chief_accountant);
      const requiresTransport = foundInFunctions.some((f) => f.requires_transport_head);
      const approvalRequired =
        requiresAccounting && requiresTransport
          ? "transport_accounting"
          : requiresAccounting
          ? "accounting"
          : requiresTransport
          ? "transport"
          : foundInFunctions.length > 0 || foundInProfiles.length > 0
          ? "standard"
          : null;

      const totalMatches = foundInFunctions.length + foundInProfiles.length + (isMandatory ? 1 : 0);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                role_query: role_name,
                found_in_business_functions: foundInFunctions,
                found_in_profiles: foundInProfiles,
                is_mandatory_role: isMandatory,
                total_matches: totalMatches,
                approval_required: approvalRequired,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

// ── HTTP-сервер ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Авторизация по токену (кроме /health и /)
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/") return next();
  const token = req.headers["x-mcp-token"] || req.query.token;
  if (token !== API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized: Invalid MCP token" });
  }
  next();
});

// ── Горячая перезагрузка базы знаний ─────────────────────────────────────────

const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR
  || path.join(__dirname, "..", "knowledge", "instructions");

let reloadInProgress = false;
let lastReloadAt = null;

async function reloadKnowledgeBase(reason = "manual") {
  if (reloadInProgress) {
    console.log(`⏳ Перезагрузка уже выполняется, пропуск (${reason})`);
    return { skipped: true, reason: "already_in_progress" };
  }
  reloadInProgress = true;
  const start = Date.now();
  try {
    const docs = loadKnowledgeBase();   // из knowledge_base.js, возвращает полные объекты с tokens
    // Пересчитываем TF-IDF индекс после загрузки
    buildTfidfIndex(docs);
    lastReloadAt = new Date().toISOString();
    const elapsed = Date.now() - start;
    const idxStats = getIndexStats();
    console.log(`✅ База знаний перезагружена (${reason}): ${docs.length} инструкций, vocab=${idxStats.vocab_size} за ${elapsed}ms`);
    return { success: true, docs_count: docs.length, elapsed_ms: elapsed, reloaded_at: lastReloadAt, index: idxStats };
  } catch (err) {
    console.error("❌ Ошибка перезагрузки базы знаний:", err.message);
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
      console.log(`📁 Изменён файл: ${filename} (${eventType}) — перезагружаю базу знаний...`);
      reloadKnowledgeBase(`fs.watch:${filename}`);
    }, 500);
  });
  console.log(`👁  Слежу за изменениями в ${KNOWLEDGE_DIR}`);
} catch (err) {
  console.warn(`⚠️  fs.watch не удалось запустить: ${err.message}`);
}

// Горячая перезагрузка базы знаний
app.post("/reload", async (req, res) => {
  const token = req.headers["x-mcp-token"] || req.query.token;
  if (token !== API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const result = await reloadKnowledgeBase("POST /reload");
  res.json({
    ...result,
    knowledge_base: {
      instruction_docs: listInstructions().length,
      last_reload: lastReloadAt,
    },
  });
});

// Health-check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "gti-1c-mcp",
    version: "1.0.0",
    tools: [
      "list_instructions",
      "search_instructions",
      "get_instruction",
      "suggest_access_profile",
      "get_roles_matrix",
      "validate_roles",
      "get_approval_level",
      "suggest_profile_by_job",
      "list_jobs",
      "semantic_search_instructions",
      "explain_profile",
      "search_by_role",
    ],
    profiles_count: ACCESS_PROFILES.length,
    knowledge_base: {
      loaded: true,
      instruction_docs: listInstructions().length,
      dir: "knowledge/instructions",
      last_reload: lastReloadAt,
    },
    tfidf_index: getIndexStats(),
    job_profiles: {
      loaded: true,
      total_jobs: Object.keys(JOB_PROFILES_MAP).length,
      source: "Employee database.xlsx (anonymized)",
    },
    timestamp: new Date().toISOString(),
  });
});

// Корень — справка по подключению
app.get("/", (req, res) => {
  res.json({
    name: "gti-1c-mcp: Инструкции 1С.БИТ + Профили доступа RBAC",
    mcp_endpoint: `http://HOST:${PORT}/mcp`,
    health: `http://HOST:${PORT}/health`,
    auth_header: "X-MCP-Token: <token>",
    docs: "Добавьте в клиент MCP: Remote → URL: http://localhost:3031/mcp, Header: X-MCP-Token: <token>",
  });
});

// ── Stateful Streamable HTTP (SDK 1.12+) ─────────────────────────────────────
// Каждая сессия — отдельный McpServer + StreamableHTTPServerTransport

const sessions = new Map(); // sessionId → { transport }

app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    // Переиспользуем существующую сессию
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
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

    // Создаём транспорт
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport });
      },
    });

    // Удаляем сессию при закрытии
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    // Создаём McpServer и регистрируем инструменты
    const server = new McpServer({
      name: "gti-1c-mcp",
      version: "1.0.0",
    });
    registerTools(server);
    await server.connect(transport);

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP handler error:", err);
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

app.listen(PORT, () => {
  console.log(`✅ gti-1c-mcp запущен на порту ${PORT}`);
  console.log(`   MCP endpoint : http://localhost:${PORT}/mcp`);
  console.log(`   Health-check : http://localhost:${PORT}/health`);
  console.log(`   Профилей     : ${ACCESS_PROFILES.length}`);
  console.log(`   Инструкций   : ${listInstructions().length}`);
  console.log(`   API Token    : ${API_TOKEN}`);

  // Строим TF-IDF индекс при старте (не блокирует запуск)
  try {
    // knowledge_base.js уже загрузила документы при import — берём их через listInstructions
    // но нам нужен полный контент с tokens, поэтому вызываем loadKnowledgeBase ещё раз
    const allDocs = loadKnowledgeBase();
    buildTfidfIndex(allDocs);
    const stats = getIndexStats();
    console.log(`   TF-IDF индекс: ${stats.docs_count} doc, vocab=${stats.vocab_size}`);
  } catch (err) {
    console.warn(`⚠️  TF-IDF индекс не построен: ${err.message}`);
  }
});
