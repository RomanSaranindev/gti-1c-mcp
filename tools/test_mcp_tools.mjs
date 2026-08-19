#!/usr/bin/env node
/**
 * test_mcp_tools.mjs — сквозная проверка MCP-инструментов через реальный MCP-клиент.
 *
 * Поднимает сервер по stdio, вызывает инструменты и печатает результаты.
 * Так проверяется именно тот путь, которым пойдёт ИИ-агент.
 *
 * Использование:
 *   node --env-file=.env tools/test_mcp_tools.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--env-file=.env", "src/server.js", "--stdio"],
  env: process.env,
  stderr: "ignore",
});

const client = new Client({ name: "test-harness", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Инструментов зарегистрировано: ${tools.length}`);
console.log("");

function head(text, n = 30) {
  return String(text).split("\n").slice(0, n).join("\n");
}

async function call(name, args, previewLines = 25) {
  console.log("=".repeat(70));
  console.log(`ВЫЗОВ: ${name}  ${JSON.stringify(args)}`);
  console.log("=".repeat(70));
  try {
    const res = await client.callTool({ name, arguments: args });
    console.log(head(res.content?.[0]?.text ?? "(нет текста)", previewLines));
  } catch (e) {
    console.log(`ОШИБКА: ${e.message}`);
  }
  console.log("");
}

// 1. Проверка соединения
await call("onec_health", {}, 14);

// 2. Блок-схема маршрута — главный сценарий бизнес-аналитика
await call("get_visa_routes", { mode: "route_graph", algorithm_code: "БС-000753", limit: 1 }, 60);

// 3. Метаданные — исправленный маппинг на list_metadata_objects
await call("get_1c_metadata", { object_type: "registers_info", object_name: "УстановленныеВизы" }, 20);

// 4. Произвольный запрос — должен честно сказать NotSupported
await call("execute_1c_query", { query_text: "ВЫБРАТЬ 1", limit: 1 }, 20);

await client.close();
