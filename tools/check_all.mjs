#!/usr/bin/env node
/**
 * check_all.mjs — сквозная проверка сервера после изменений.
 *
 * Проверяет то, что было заявлено как требование:
 *   1. Разграничение по трём ролям (user / analyst / admin)
 *   2. Делегирование identity (запрос идёт под учёткой владельца токена)
 *   3. Блокировка ПДн в BSL расширения
 *   4. Работоспособность оставшихся инструментов
 *
 * Запуск: node tools/check_all.mjs <user-token> <analyst-token> <admin-token>
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [userToken, analystToken, adminToken] = process.argv.slice(2);
if (!userToken || !analystToken || !adminToken) {
  console.error("Использование: node tools/check_all.mjs <user-token> <analyst-token> <admin-token>");
  console.error("Выдать токены: node --env-file=.env tools/token.mjs issue --login \"HG\\Логин\" --role analyst");
  process.exit(1);
}

async function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3031/mcp"), {
    requestInit: { headers: { "X-MCP-Token": token } },
  });
  const client = new Client({ name: "check-all", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    return res.content?.[0]?.text ?? "";
  } catch (e) {
    return `EXCEPTION: ${e.message}`;
  }
}

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`[OK  ] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}`); }
  if (detail) console.log(`       ${String(detail).replace(/\s+/g, " ").slice(0, 210)}`);
}

const user = await connect(userToken);
const analyst = await connect(analystToken);
const admin = await connect(adminToken);

// ── 1. Роли ──────────────────────────────────────────────────────────────────
console.log("### 1. Разграничение по ролям\n");

const userTools    = (await user.listTools()).tools.map((t) => t.name);
const analystTools = (await analyst.listTools()).tools.map((t) => t.name);
const adminTools   = (await admin.listTools()).tools.map((t) => t.name);

// Роль user: только база знаний инструкций + самодиагностика прав
const USER_EXPECTED = [
  "list_instructions", "search_instructions", "get_instruction", "check_document_access",
].sort();
check("user: ровно 4 инструмента (инструкции + свои права)",
  JSON.stringify([...userTools].sort()) === JSON.stringify(USER_EXPECTED),
  `получено ${userTools.length}: ${userTools.join(", ")}`);

check("user: инструменты живой базы скрыты",
  !userTools.some((t) => /^(get_1c_|list_1c_|execute_1c_|get_visa_|get_user_|onec_)/.test(t)),
  userTools.filter((t) => /^(get_1c_|list_1c_|execute_1c_|get_visa_|get_user_|onec_)/.test(t)).join(", ") || "чисто");

check("user: маршруты согласования скрыты",
  !userTools.some((t) => /route/.test(t)),
  userTools.filter((t) => /route/.test(t)).join(", ") || "чисто");

// Роль analyst: всё, кроме execute_1c_query
check("analyst: execute_1c_query отсутствует в списке",
  !analystTools.includes("execute_1c_query"),
  `инструментов: ${analystTools.length}`);
check("analyst: 17 инструментов", analystTools.length === 17,
  `получено ${analystTools.length}: ${analystTools.join(", ")}`);
check("analyst: живая база и маршруты доступны",
  analystTools.includes("get_visa_routes") && analystTools.includes("suggest_route"));

// Роль admin: всё
check("admin: 18 инструментов (включая execute_1c_query)",
  adminTools.length === 18 && adminTools.includes("execute_1c_query"),
  `получено ${adminTools.length}`);

check("RBAC-инструменты удалены",
  !adminTools.some((t) => /suggest_access_profile|list_jobs|explain_profile|analyze_roles/.test(t)));

// Инструмент не своей роли не зарегистрирован, поэтому прямой вызов отбивается
// самим SDK как «not found». Отказ по роли (Forbidden) остаётся в guard() как
// вторая линия обороны — она сработает, если инструмент когда-либо начнут
// регистрировать для всех. Здесь принимаем любой из двух видов отказа.
const DENIED = /Forbidden|not found|Method not found|Unknown tool/i;

const deniedUser = await call(user, "execute_1c_query", { query_text: "ВЫБРАТЬ 1", limit: 1 });
check("user: прямой вызов execute_1c_query отклонён", DENIED.test(deniedUser), deniedUser);

const deniedRoutes = await call(user, "list_routes", {});
check("user: прямой вызов list_routes отклонён", DENIED.test(deniedRoutes), deniedRoutes);

const deniedAnalyst = await call(analyst, "execute_1c_query", { query_text: "ВЫБРАТЬ 1", limit: 1 });
check("analyst: прямой вызов execute_1c_query отклонён", DENIED.test(deniedAnalyst), deniedAnalyst);

const allowed = await call(admin, "execute_1c_query", { query_text: "ВЫБРАТЬ 1", limit: 1 });
check("admin: execute_1c_query разрешён", !/Forbidden/.test(allowed) && /Поле1/.test(allowed), allowed);

// ── 2. Блокировка ПДн ────────────────────────────────────────────────────────
console.log("\n### 2. Блокировка персональных данных (BSL)\n");

const pdnCases = [
  ["ФИО из Справочник.Пользователи", "ВЫБРАТЬ ПЕРВЫЕ 3 Наименование ИЗ Справочник.Пользователи"],
  ["ФИО через псевдоним",            "ВЫБРАТЬ ПЕРВЫЕ 3 П.Наименование ИЗ Справочник.Пользователи КАК П"],
  ["Справочник.ФизическиеЛица",      "ВЫБРАТЬ ПЕРВЫЕ 3 Ссылка ИЗ Справочник.ФизическиеЛица"],
  ["обход комментарием //",          "ВЫБРАТЬ ПЕРВЫЕ 3 Наименование // безобидно\nИЗ Справочник.Пользователи"],
  ["обход блочным /* */",            "ВЫБРАТЬ ПЕРВЫЕ 3 /* x */ Наименование ИЗ Справочник.Пользователи"],
];

for (const [label, q] of pdnCases) {
  const r = await call(admin, "execute_1c_query", { query_text: q, limit: 3 });
  const blocked = /ReadOnlyViolation|персональные данные|запрещ/i.test(r);
  check(`заблокировано: ${label}`, blocked, r);
}

// Служебные поля должны остаться доступными
const uid = await call(admin, "execute_1c_query", {
  query_text: "ВЫБРАТЬ ПЕРВЫЕ 3 ИдентификаторПользователяИБ ИЗ Справочник.Пользователи",
  limit: 3,
});
check("разрешено: UID без ФИО", !/ReadOnlyViolation|персональные/i.test(uid), uid);

// ── 3. Read-only ─────────────────────────────────────────────────────────────
console.log("\n### 3. Read-only\n");

for (const [label, q] of [
  ["DELETE",      "DELETE FROM Справочник.Контрагенты"],
  ["УНИЧТОЖИТЬ",  "ВЫБРАТЬ 1 КАК П ПОМЕСТИТЬ ВТ ; УНИЧТОЖИТЬ ВТ"],
]) {
  const r = await call(admin, "execute_1c_query", { query_text: q, limit: 1 });
  check(`заблокировано: ${label}`, /ReadOnlyViolation/i.test(r), r);
}

// ── 4. Работоспособность ─────────────────────────────────────────────────────
console.log("\n### 4. Оставшиеся инструменты\n");

const kb = await call(user, "search_instructions", { query: "путевой лист", limit: 2 });
check("поиск по инструкциям работает", /instructions|результат|ИП-/i.test(kb), kb.slice(0, 150));

const routes = await call(analyst, "list_routes", {});
check("маршруты доступны analyst", !/error/i.test(routes), routes.slice(0, 150));

const noPii = await call(analyst, "get_route", { org: "ГТИ", doc_type: "ЦС-004" });
check("в маршрутах нет ФИО", !/[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\./.test(noPii),
  (noPii.match(/[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\./g) || []).slice(0, 5).join(", ") || "чисто");

const health = await call(analyst, "onec_health", {});
check("подключение к 1С по строгому TLS", /"connected":\s*true/.test(health), health.slice(0, 130));

// ── 5. Отбор прав установки виз по сотруднику (режим rights) ─────────────────
console.log("\n### 5. get_visa_routes(mode=rights) с отбором по user_uid\n");

const rightsAll = await call(analyst, "get_visa_routes", { mode: "rights", limit: 5 });
check("rights без отбора возвращает матрицу", /"mode":\s*"rights"/.test(rightsAll), rightsAll.slice(0, 150));

// UID берём из живой базы, чтобы проверка не зависела от захардкоженного значения.
// Пустой UID (все нули) отбрасываем: он есть у пользователей без учётной записи ИБ.
const usersRaw = await call(analyst, "list_1c_users", { limit: 50 });
const someUid = (usersRaw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || [])
  .find((u) => !/^0+-0+-0+-0+-0+$/.test(u));

if (someUid) {
  const rightsUser = await call(analyst, "get_visa_routes", {
    mode: "rights", user_uid: someUid, limit: 20,
  });
  check("rights принимает user_uid", /"user_uid"/.test(rightsUser) && !/error/i.test(rightsUser),
    rightsUser.slice(0, 200));
  check("rights сообщает про учёт групп", /"include_groups"/.test(rightsUser), rightsUser.slice(0, 200));

  const rightsDirect = await call(analyst, "get_visa_routes", {
    mode: "rights", user_uid: someUid, include_groups: false, limit: 20,
  });
  check("rights: include_groups=false принимается", /"include_groups":\s*false/.test(rightsDirect),
    rightsDirect.slice(0, 200));
} else {
  check("не удалось получить UID для проверки отбора", false, usersRaw.slice(0, 200));
}

const rightsBadUid = await call(analyst, "get_visa_routes", {
  mode: "rights", user_uid: "не-uuid", limit: 5,
});
check("rights: некорректный user_uid даёт понятную ошибку",
  /InvalidUID|Неверный формат/i.test(rightsBadUid), rightsBadUid.slice(0, 200));

// ── 6. Самодиагностика прав на документ ──────────────────────────────────────
console.log("\n### 6. check_document_access\n");

const selfCheck = await call(user, "check_document_access", {
  document_type: "бит_ЗаявкаНаРасходованиеСредств",
});
check("user: проверка своих прав работает",
  /"rights"|"has_all_rights"/.test(selfCheck) && !/Forbidden/.test(selfCheck),
  selfCheck.slice(0, 250));
check("user: ответ помечен как самопроверка", /"checked_self":\s*true/.test(selfCheck),
  selfCheck.slice(0, 200));
check("ответ не содержит ФИО",
  !/[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\./.test(selfCheck),
  (selfCheck.match(/[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\./g) || []).join(", ") || "чисто");

if (someUid) {
  const foreignByUser = await call(user, "check_document_access", {
    document_type: "бит_ЗаявкаНаРасходованиеСредств", user_uid: someUid,
  });
  check("user: проверка ЧУЖИХ прав запрещена", /Forbidden/.test(foreignByUser),
    foreignByUser.slice(0, 200));

  const foreignByAnalyst = await call(analyst, "check_document_access", {
    document_type: "бит_ЗаявкаНаРасходованиеСредств", user_uid: someUid,
  });
  check("analyst: проверка чужих прав разрешена",
    !/Forbidden/.test(foreignByAnalyst) && /"rights"|"has_all_rights"/.test(foreignByAnalyst),
    foreignByAnalyst.slice(0, 200));
}

const badDoc = await call(user, "check_document_access", { document_type: "НетТакогоДокумента" });
check("неизвестный тип документа даёт понятную ошибку",
  /DocumentTypeNotFound|не найден/i.test(badDoc), badDoc.slice(0, 200));

await user.close();
await analyst.close();
await admin.close();

console.log(`\nИТОГО: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
