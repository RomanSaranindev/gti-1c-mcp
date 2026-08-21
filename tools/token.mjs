#!/usr/bin/env node
/**
 * token.mjs — управление персональными токенами доступа.
 *
 * Команды:
 *   genkey                                   — сгенерировать MCP_SECRET_KEY для .env
 *   issue  --login <домен\логин> [опции]     — выдать токен
 *   list                                     — показать все токены (без секретов)
 *   revoke --id <tok_xxx>                    — отозвать токен
 *   restore --id <tok_xxx>                   — снять отзыв
 *   remove --id <tok_xxx>                    — удалить запись целиком
 *
 * Опции issue:
 *   --login    <строка>   доменный логин 1С, например "HG\ИвановИИ"  (обязательно)
 *   --password <строка>   пароль 1С; если не указан — спросит интерактивно
 *   --role     <роль>     user | analyst | admin (по умолчанию user)
 *   --comment  <строка>   пометка: ФИО, отдел
 *   --days     <число>    срок действия в днях (по умолчанию 365; 0 = бессрочно)
 *
 * Роли:
 *   user    — только инструкции (база знаний) и проверка собственных прав
 *             на документ (check_document_access). Данных живой базы не видит.
 *   analyst — всё, кроме execute_1c_query: маршруты, визы, права, документы,
 *             метаданные, диагностика прав любого сотрудника.
 *   admin   — плюс execute_1c_query (произвольный запрос), POST /reload, GET /status.
 *
 * Примеры:
 *   node tools/token.mjs genkey
 *   node --env-file=.env tools/token.mjs issue --login "HG\ИвановИИ" --comment "Иванов, бухгалтерия"
 *   node --env-file=.env tools/token.mjs issue --login "HG\СидороваАА" --role analyst --comment "Сидорова, фин.контроль"
 *   node --env-file=.env tools/token.mjs issue --login "HG\ПетровПП" --role admin --days 90
 *   node --env-file=.env tools/token.mjs list
 *   node --env-file=.env tools/token.mjs revoke --id tok_a1b2c3d4
 */

import crypto from "node:crypto";
import readline from "node:readline";
import {
  ROLES, ROLE_LABELS, TOKENS_PATH,
  loadTokens, saveTokens,
  generateToken, hashToken, encryptPassword,
} from "../src/auth.js";

// ── Разбор аргументов ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const command = argv[0];

function opt(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

function die(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

/** Краткое описание доступа роли — печатается при выдаче токена. */
const ROLE_ACCESS_SUMMARY = {
  user:    "инструкции + проверка своих прав на документ",
  analyst: "всё, кроме произвольного запроса (execute_1c_query)",
  admin:   "все инструменты, /reload и /status",
};

/** Скрытый ввод пароля — символы не отображаются в терминале. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      if (["\n", "\r", "\u0004"].includes(char.toString())) {
        process.stdin.removeListener("data", onData);
      } else {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(question);
      }
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

// ── Команды ───────────────────────────────────────────────────────────────────

function cmdGenkey() {
  const key = crypto.randomBytes(32).toString("base64");
  console.log("Добавьте в .env:\n");
  console.log(`MCP_SECRET_KEY=${key}\n`);
  console.log("Этим ключом шифруются пароли 1С в tokens.json.");
  console.log("ВАЖНО: при смене ключа все ранее выданные токены перестанут работать.");
}

async function cmdIssue() {
  const login = opt("login");
  if (!login) die('не указан --login (например: --login "HG\\ИвановИИ")');

  const role = opt("role", "user");
  if (!ROLES.includes(role)) die(`недопустимая роль '${role}'. Допустимо: ${ROLES.join(", ")}`);

  const days = Number(opt("days", "365"));
  if (!Number.isFinite(days) || days < 0) die("--days должно быть неотрицательным числом");

  let password = opt("password");
  if (!password) password = await askHidden(`Пароль 1С для ${login}: `);
  if (!password) die("пароль не может быть пустым");

  const token = generateToken();
  const entry = {
    id: "tok_" + crypto.randomBytes(4).toString("hex"),
    token_hash: hashToken(token),
    login,
    password_enc: encryptPassword(password),
    role,
    comment: opt("comment", ""),
    created_at: new Date().toISOString(),
    expires_at: days === 0 ? null : new Date(Date.now() + days * 86400_000).toISOString(),
    revoked: false,
    last_used_at: null,
  };

  const store = loadTokens();
  store.tokens.push(entry);
  saveTokens(store);

  console.log("\nТокен выдан.\n");
  console.log(`  id       : ${entry.id}`);
  console.log(`  логин 1С : ${entry.login}`);
  console.log(`  роль     : ${entry.role} (${ROLE_LABELS[entry.role] || "?"})`);
  console.log(`  доступ   : ${ROLE_ACCESS_SUMMARY[entry.role] || "?"}`);
  console.log(`  до       : ${entry.expires_at || "бессрочно"}`);
  console.log(`\n  ТОКЕН    : ${token}\n`);
  console.log("Передайте токен пользователю по защищённому каналу.");
  console.log("Повторно его показать нельзя — хранится только хеш.\n");
  console.log("Конфиг для MCP-клиента:\n");
  console.log(JSON.stringify({
    mcp: {
      "gti-1c": {
        type: "remote",
        url: "http://<сервер>:3031/mcp",
        headers: { "X-MCP-Token": token },
        enabled: true,
      },
    },
  }, null, 2));
}

function cmdList() {
  const { tokens } = loadTokens();
  if (tokens.length === 0) {
    console.log(`Токенов нет. Файл: ${TOKENS_PATH}`);
    console.log('Выдать: node --env-file=.env tools/token.mjs issue --login "HG\\Логин"');
    return;
  }

  const now = new Date();
  console.log(`Реестр: ${TOKENS_PATH}\n`);
  for (const t of tokens) {
    const expired = t.expires_at && new Date(t.expires_at) < now;
    const state = t.revoked ? "ОТОЗВАН" : expired ? "ИСТЁК" : "активен";
    console.log(`${t.id}  [${state}]  role=${t.role} (${ROLE_LABELS[t.role] || "неизвестна"})`);
    console.log(`   логин 1С   : ${t.login}`);
    if (t.comment) console.log(`   комментарий: ${t.comment}`);
    console.log(`   выдан      : ${t.created_at?.slice(0, 10)}`);
    console.log(`   действует  : ${t.expires_at ? t.expires_at.slice(0, 10) : "бессрочно"}`);
    console.log(`   последний  : ${t.last_used_at ? t.last_used_at.slice(0, 16).replace("T", " ") : "не использовался"}`);
    console.log("");
  }
  const active = tokens.filter((t) => !t.revoked && !(t.expires_at && new Date(t.expires_at) < now));
  const byRole = ROLES.map((r) => `${r}: ${active.filter((t) => t.role === r).length}`).join(", ");
  console.log(`Всего: ${tokens.length}, активных: ${active.length} (${byRole})`);
}

function setRevoked(flag, verb) {
  const id = opt("id");
  if (!id) die("не указан --id");
  const store = loadTokens();
  const entry = store.tokens.find((t) => t.id === id);
  if (!entry) die(`токен ${id} не найден`);
  entry.revoked = flag;
  saveTokens(store);
  console.log(`Токен ${id} (${entry.login}) ${verb}.`);
}

function cmdRemove() {
  const id = opt("id");
  if (!id) die("не указан --id");
  const store = loadTokens();
  const before = store.tokens.length;
  store.tokens = store.tokens.filter((t) => t.id !== id);
  if (store.tokens.length === before) die(`токен ${id} не найден`);
  saveTokens(store);
  console.log(`Запись ${id} удалена.`);
}

// ── Точка входа ───────────────────────────────────────────────────────────────

const commands = {
  genkey:  cmdGenkey,
  issue:   cmdIssue,
  list:    cmdList,
  revoke:  () => setRevoked(true, "отозван"),
  restore: () => setRevoked(false, "восстановлен"),
  remove:  cmdRemove,
};

if (!command || !commands[command]) {
  console.log("Управление токенами gti-1c-mcp\n");
  console.log("  genkey                                  сгенерировать MCP_SECRET_KEY");
  console.log("  issue  --login <домен\\логин> [опции]    выдать токен");
  console.log("  list                                    список токенов");
  console.log("  revoke  --id <tok_xxx>                  отозвать");
  console.log("  restore --id <tok_xxx>                  восстановить");
  console.log("  remove  --id <tok_xxx>                  удалить запись");
  console.log("\nОпции issue: --password --role user|analyst|admin --comment --days");
  console.log("\nРоли:");
  for (const r of ROLES) {
    console.log(`  ${r.padEnd(8)} ${ROLE_LABELS[r].padEnd(15)} ${ROLE_ACCESS_SUMMARY[r]}`);
  }
  process.exit(command ? 1 : 0);
}

try {
  await commands[command]();
} catch (err) {
  die(err.message);
}
