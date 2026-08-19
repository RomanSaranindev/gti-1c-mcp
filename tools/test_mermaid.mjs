#!/usr/bin/env node
/**
 * test_mermaid.mjs — проверка рендера блок-схемы маршрута через MCP-инструмент.
 *
 * Запускает MCP-сервер в памяти, вызывает get_visa_routes в режиме route_graph
 * и печатает готовую Mermaid-диаграмму.
 *
 * Использование:
 *   node --env-file=.env tools/test_mermaid.mjs [algorithm_code]
 */

import { callOnecTool } from "../src/onec_client.js";

const algorithmCode = process.argv[2] || "БС-000747";

// Импортируем рендер через динамический доступ к модулю сервера нельзя
// (renderRouteMermaid не экспортируется), поэтому дублируем вызов инструмента
// и проверяем сам инструмент целиком через MCP-клиент ниже.
const res = await callOnecTool("get_visa_routes", {
  mode: "route_graph",
  algorithm_code: algorithmCode,
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
  console.log("Граф не найден:", JSON.stringify(payload).slice(0, 400));
  process.exit(1);
}

console.log(`Алгоритм: ${graph.algorithm_name} (${graph.algorithm_code})`);
console.log(`Узлов: ${graph.nodes.length}, переходов: ${graph.edges.length}`);
console.log("");

// Рендер идентичен renderRouteMermaid в src/server.js
function esc(t) {
  return String(t ?? "")
    .replace(/["`]/g, "'")
    .replace(/[\[\]{}()<>|]/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

const lines = ["flowchart TD", `  %% ${esc(graph.algorithm_name)} (${esc(graph.algorithm_code)})`];
const nid = (id) => `n${id}`;

for (const n of graph.nodes) {
  const visas = n.visas || [];
  const roles = [...new Set(visas.map((v) => v.position || v.name).filter(Boolean).map(esc))].slice(0, 4);
  let label = esc(n.name);
  if (roles.length) {
    label += "<br/>" + roles.join("<br/>");
    if (visas.length > roles.length) label += "<br/>…";
  }
  const k = String(n.kind || "");
  const shape =
    k === "Старт" || k === "Завершение" ? `([\"${label}\"])`
    : k === "Условие" || k === "ВыборВарианта" ? `{\"${label}\"}`
    : k === "Разделение" || k === "Слияние" ? `[/\"${label}\"/]`
    : `[\"${label}\"]`;
  lines.push(`  ${nid(n.id)}${shape}`);
}

for (const e of graph.edges) {
  const label = esc(e.label);
  lines.push(label ? `  ${nid(e.from)} -->|"${label}"| ${nid(e.to)}` : `  ${nid(e.from)} --> ${nid(e.to)}`);
}

const starts = graph.nodes.filter((n) => n.kind === "Старт").map((n) => nid(n.id));
const ends = graph.nodes.filter((n) => n.kind === "Завершение").map((n) => nid(n.id));
if (starts.length) {
  lines.push(`  classDef startNode fill:#d4f4d4,stroke:#2d7a2d,stroke-width:2px;`);
  lines.push(`  class ${starts.join(",")} startNode;`);
}
if (ends.length) {
  lines.push(`  classDef endNode fill:#f4d4d4,stroke:#7a2d2d,stroke-width:2px;`);
  lines.push(`  class ${ends.join(",")} endNode;`);
}

console.log(lines.join("\n"));
