#!/usr/bin/env node
/**
 * probe.mjs — прямой вызов инструментов расширения 1С (для отладки).
 *
 * Использование:
 *   node --env-file=.env tools/probe.mjs <tool_name> '<json_args>'
 *   node --env-file=.env tools/probe.mjs --list
 */

import { callOnecTool, listOnecTools } from "../src/onec_client.js";

// Аргументы: либо JSON-строкой, либо парами key=value (удобно для PowerShell)
const argv = process.argv.slice(2);
const toolName = argv[0];
const rest = argv.slice(1);

function parseArgs(parts) {
  if (parts.length === 0) return {};
  const joined = parts.join(" ").trim();
  if (joined.startsWith("{")) return JSON.parse(joined);
  const obj = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    const key = p.slice(0, i);
    const raw = p.slice(i + 1);
    obj[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw)
      : raw === "true" ? true
      : raw === "false" ? false
      : raw;
  }
  return obj;
}

function out(v) {
  process.stdout.write(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  process.stdout.write("\n");
}

try {
  if (!toolName || toolName === "--list") {
    out(await listOnecTools());
  } else {
    const args = parseArgs(rest);
    const res = await callOnecTool(toolName, args);
    // Расширение возвращает { content: [ { type:"text", text:"..." } ] }
    const text = res?.content?.[0]?.text;
    out(text !== undefined ? text : res);
  }
} catch (err) {
  out({ error: err.name, message: err.message });
  process.exitCode = 1;
}
