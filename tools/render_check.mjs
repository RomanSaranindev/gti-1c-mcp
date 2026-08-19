#!/usr/bin/env node
/**
 * render_check.mjs — проверка блок-схемы маршрута на живой базе 1С.
 *
 * Использует тот же модуль рендера, что и MCP-сервер (src/route_mermaid.js),
 * поэтому вывод здесь идентичен тому, что получит ИИ-агент.
 *
 *   node --env-file=.env tools/render_check.mjs [algorithm_code]
 */

import { callOnecTool } from "../src/onec_client.js";
import { renderRouteMermaid } from "../src/route_mermaid.js";

const code = process.argv[2] || "БС-000747";

const res = await callOnecTool("get_visa_routes", {
  mode: "route_graph",
  algorithm_code: code,
  document_type: "",
  visa_code: "",
  status_filter: "all",
  date_from: "",
  date_to: "",
  limit: 1,
});

const payload = JSON.parse(res.content[0].text);
const graph = payload.graphs?.[0];

if (!graph) {
  console.log("Граф не найден. Ответ:", JSON.stringify(payload).slice(0, 400));
  process.exit(1);
}

console.log(
  `${graph.algorithm_name} (${graph.algorithm_code}) — ` +
  `узлов ${graph.nodes.length}, рёбер ${graph.edges.length}\n`
);
console.log(renderRouteMermaid(graph));
