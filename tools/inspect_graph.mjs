#!/usr/bin/env node
/**
 * inspect_graph.mjs — диагностика полноты графа маршрута.
 *
 * Показывает, что именно возвращает режим route_graph по узлам-условиям:
 * есть ли машиночитаемые пороги (суммы), или только текстовая подпись.
 *
 *   node --env-file=.env tools/inspect_graph.mjs [algorithm_code]
 */

import { callOnecTool } from "../src/onec_client.js";

const code = process.argv[2] || "БС-000747";

const res = await callOnecTool("get_visa_routes", {
  mode: "route_graph", algorithm_code: code, document_type: "",
  visa_code: "", status_filter: "all", date_from: "", date_to: "", limit: 1,
});

const g = JSON.parse(res.content[0].text).graphs?.[0];
if (!g) { console.log("нет графа"); process.exit(1); }

console.log(`Алгоритм: ${g.algorithm_name} (${g.algorithm_code})`);
console.log(`Узлов: ${g.nodes.length}  Переходов: ${g.edges.length}`);

const byKind = {};
for (const n of g.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
console.log("По видам точек:", JSON.stringify(byKind, null, 0));

console.log("\n--- УЗЛЫ-УСЛОВИЯ (что отдаём пользователю) ---");
for (const n of g.nodes.filter((x) => x.kind === "Условие")) {
  console.log(`  id=${n.id}  name="${n.name}"`);
  console.log(`         condition="${n.condition}"`);
  const outs = g.edges.filter((e) => e.from === n.id);
  for (const e of outs) console.log(`         --[${e.label || "(без метки)"}]--> ${e.to} "${e.to_name}"`);
  if (outs.length < 2) console.log(`         !! веток: ${outs.length} (у условия должно быть 2: Да и Нет)`);
}

console.log("\n--- ИЗОЛИРОВАННЫЕ УЗЛЫ (нет входящих и исходящих) ---");
const linked = new Set();
for (const e of g.edges) { linked.add(e.from); linked.add(e.to); }
const orphans = g.nodes.filter((n) => !linked.has(n.id));
console.log(orphans.length ? orphans.map((n) => `  id=${n.id} "${n.name}" [${n.kind}]`).join("\n") : "  нет");

console.log("\n--- ССЫЛКИ НА ОТСУТСТВУЮЩИЕ УЗЛЫ ---");
const ids = new Set(g.nodes.map((n) => n.id));
const dangling = g.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
console.log(dangling.length ? dangling.map((e) => `  ${e.from} -> ${e.to}`).join("\n") : "  нет");

console.log("\n--- ВИЗЫ НА УЗЛАХ ---");
const withVisas = g.nodes.filter((n) => (n.visas || []).length > 0).length;
const actions = g.nodes.filter((n) => n.kind === "Действие").length;
console.log(`  Действий: ${actions}, из них с визами: ${withVisas}`);
for (const n of g.nodes.filter((x) => x.kind === "Действие")) {
  const v = (n.visas || []).map((x) => x.position || x.name).filter(Boolean);
  console.log(`  id=${n.id} "${n.name}" -> визы: ${v.length ? v.join(", ") : "(пусто)"}`);
}
