#!/usr/bin/env node
/**
 * inspect_rules.mjs — проверка машиночитаемых правил условий (пороги сумм).
 *
 *   node --env-file=.env tools/inspect_rules.mjs [algorithm_code]
 */

import { callOnecTool } from "../src/onec_client.js";

const code = process.argv[2] || "БС-000747";

const res = await callOnecTool("get_visa_routes", {
  mode: "route_graph", algorithm_code: code, document_type: "",
  visa_code: "", status_filter: "all", date_from: "", date_to: "", limit: 1,
});

const raw = res.content[0].text;
const payload = JSON.parse(raw);
const g = payload.graphs?.[0];
if (!g) { console.log("нет графа:", raw.slice(0, 300)); process.exit(1); }

console.log(`Алгоритм: ${g.algorithm_name} (${g.algorithm_code})`);
console.log(`Узлов: ${g.nodes.length}  Переходов: ${g.edges.length}`);

const first = g.nodes[0];
console.log("\n--- ПОЛЯ УЗЛА (проверка, что новые поля пришли) ---");
console.log(Object.keys(first).join(", "));

console.log("\n--- УСЛОВИЯ: ПОРОГИ ---");
let withRules = 0;
for (const n of g.nodes.filter((x) => x.kind === "Условие" || x.kind === "ВыборВарианта")) {
  const rules = n.condition_rules || [];
  if (rules.length) withRules++;
  console.log(`\nid=${n.id} "${n.name}"`);
  console.log(`  condition       : ${n.condition}`);
  console.log(`  condition_code  : ${n.condition_code ?? "(нет поля)"}`);
  console.log(`  condition_text  : ${n.condition_text ?? "(нет поля)"}`);
  console.log(`  condition_expr  : ${n.condition_expression ?? "(нет поля)"}`);
  if (rules.length) {
    for (const r of rules) {
      console.log(`    RULE: ${r.bracket_open}${r.property} ${r.comparison} ${r.value}${r.bracket_close}  [join=${r.join}]`);
    }
  } else {
    console.log(`    !! condition_rules пусто`);
  }
}
console.log(`\nИТОГО условий с правилами: ${withRules} из ${g.nodes.filter((x)=>x.kind==="Условие").length}`);

console.log("\n--- ВИЗЫ: настройка vs факт ---");
const acts = g.nodes.filter((n) => n.kind === "Действие");
let cfg = 0, act = 0;
for (const n of acts) {
  const v = n.visas || [], va = n.visas_actual || [];
  if (v.length) cfg++;
  if (va.length) act++;
  console.log(`  id=${n.id} "${n.name}"`);
  console.log(`      visas(настройка)=${v.map((x)=>x.name).join("; ") || "(пусто)"}  role=${n.role ?? "-"}`);
  console.log(`      visas_actual    =${va.map((x)=>x.name).join("; ") || "(пусто)"}`);
}
console.log(`\nДействий: ${acts.length}, с визами: ${cfg}, с фактическими: ${act}`);
