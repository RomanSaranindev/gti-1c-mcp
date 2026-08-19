/**
 * route_mermaid.js - построение блок-схемы маршрута согласования (Mermaid).
 *
 * Преобразует граф маршрута из режима route_graph инструмента get_visa_routes
 * (узлы бит_ТочкиАлгоритмов + переходы из ТЧ Входящие/ИсходящиеТочки)
 * в диаграмму Mermaid flowchart.
 *
 * Формы узлов отражают вид точки алгоритма БИТ.ФИНАНС:
 *   Старт/Завершение     -> ([скруглённый])
 *   Условие/ВыборВарианта -> {ромб}
 *   Разделение/Слияние   -> [/параллелограмм/]
 *   Действие и прочее    -> [прямоугольник]
 */
// ── Блок-схема маршрута согласования (Mermaid) ────────────────────────────────

/**
 * Экранирует текст для использования внутри подписи узла Mermaid.
 * Кавычки и спецсимволы ломают парсер, поэтому чистим агрессивно.
 */
export function mermaidEscape(text) {
  return String(text ?? "")
    .replace(/["`]/g, "'")
    // Операторы сравнения экранируем HTML-сущностями, а не вырезаем:
    // иначе «>= 15 млн» превращается в «= 15 млн» и смысл порога искажается.
    .replace(/>=/g, "&ge;")
    .replace(/<=/g, "&le;")
    .replace(/<>/g, "&ne;")
    .replace(/>/g, "&gt;")
    .replace(/</g, "&lt;")
    .replace(/[\[\]{}()|]/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Сжимает правило условия до читаемой выжимки порогов.
 *
 * В базе правило приходит как выражение на встроенном языке, например:
 *   "гти_ОбщийМодульСервер.ПолучитьСуммуККОсновнойККДопСоглашенийКК(
 *      СтруктураКонтекст.ТекущийОбъект) >= 30000000 И ... < 150000000"
 * Показывать это на схеме нечитаемо, поэтому вытаскиваем только операторы
 * сравнения с числами и форматируем суммы: ">= 30 млн И < 150 млн".
 *
 * @param {string} expr — выражение условия из 1С
 * @returns {string} — краткая выжимка либо "" если порогов не найдено
 */
export function summarizeCondition(expr) {
  const text = String(expr || "").trim();
  if (!text) return "";

  // Ищем пары «оператор сравнения + число»
  const re = /(>=|<=|<>|>|<|=)\s*(\d[\d\s]*)/g;
  const parts = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const op = m[1];
    const num = Number(String(m[2]).replace(/\s/g, ""));
    if (!Number.isFinite(num)) continue;
    parts.push(`${op} ${formatAmountShort(num)}`);
  }
  if (parts.length === 0) return "";

  // Связка: если в выражении есть ИЛИ — значит ветвление, иначе диапазон
  const join = /\bИЛИ\b/i.test(text) && !/\bИ\b/.test(text) ? " ИЛИ " : " И ";
  return parts.slice(0, 3).join(join);
}

/** Форматирует сумму коротко: 30000000 → "30 млн", 500000 → "500 тыс". */
export function formatAmountShort(num) {
  if (num >= 1_000_000_000) return `${trimZeros(num / 1_000_000_000)} млрд`;
  if (num >= 1_000_000)     return `${trimZeros(num / 1_000_000)} млн`;
  if (num >= 1_000)         return `${trimZeros(num / 1_000)} тыс`;
  return String(num);
}

export function trimZeros(v) {
  return String(Number(v.toFixed(2)));
}

/**
 * Формирует Mermaid flowchart по графу маршрута из режима route_graph.
 *
 * Форма узла отражает вид точки алгоритма БИТ.ФИНАНС:
 *   Старт/Завершение   → ([скруглённый])
 *   Условие/ВыборВарианта → {ромб}
 *   Разделение/Слияние → [/параллелограмм/]
 *   Действие и прочее  → [прямоугольник]
 *
 * @param {{algorithm_code:string, algorithm_name:string, nodes:Array, edges:Array}} graph
 * @returns {string} — текст диаграммы Mermaid
 */
export function renderRouteMermaid(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  if (nodes.length === 0) {
    return `flowchart TD\n  empty["Нет узлов маршрута"]`;
  }

  const lines = [
    "flowchart TD",
    `  %% ${mermaidEscape(graph.algorithm_name)} (${mermaidEscape(graph.algorithm_code)})`,
  ];

  const nodeId = (id) => `n${id}`;

  for (const n of nodes) {
    const kind = String(n.kind || "");
    let label = mermaidEscape(n.name);

    if (kind === "Условие" || kind === "ВыборВарианта") {
      // Наименование условия — только подпись, реальное правило может отличаться
      // (напр. узел «Сумма от 500 тыс.руб» при правиле с порогом «(КК)»).
      // Показываем компактную выжимку порогов из фактического правила.
      const rule = summarizeCondition(n.condition_text || n.condition_expression || "");
      if (rule && rule !== label) label += "<br/>" + mermaidEscape(rule);
    } else {
      // Подпись: имя шага + визы/должности, которые на нём ставятся.
      // Исключаем дубли имени узла: виза обычно называется так же, как шаг.
      // Сравниваем ДО экранирования и без учёта знаков — иначе
      // «Бухгалтер (АРЦ)» и «Бухгалтер АРЦ» считаются разными.
      const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      const visas = Array.isArray(n.visas) ? n.visas : [];
      const nameNorm = norm(n.name);
      const roles = [...new Set(
        visas.map((v) => v.position || v.name)
             .filter(Boolean)
             .filter((r) => norm(r) !== nameNorm)
             .map(mermaidEscape)
      )].slice(0, 4);
      if (roles.length > 0) {
        label += "<br/>" + roles.join("<br/>");
        if (visas.length > roles.length) label += "<br/>…";
      }
    }

    let shape;
    if (kind === "Старт" || kind === "Завершение") {
      shape = `([\"${label}\"])`;
    } else if (kind === "Условие" || kind === "ВыборВарианта") {
      shape = `{\"${label}\"}`;
    } else if (kind === "Разделение" || kind === "Слияние") {
      shape = `[/\"${label}\"/]`;
    } else {
      shape = `[\"${label}\"]`;
    }

    lines.push(`  ${nodeId(n.id)}${shape}`);
  }

  for (const e of edges) {
    const label = mermaidEscape(e.label);
    lines.push(
      label
        ? `  ${nodeId(e.from)} -->|"${label}"| ${nodeId(e.to)}`
        : `  ${nodeId(e.from)} --> ${nodeId(e.to)}`
    );
  }

  // Условие без второй ветки — дыра в настройке маршрута в 1С.
  // Показываем явно, иначе на схеме маршрут молча обрывается.
  const gaps = [];
  for (const n of nodes) {
    if (n.kind !== "Условие" && n.kind !== "ВыборВарианта") continue;
    const outs = edges.filter((e) => e.from === n.id);
    const labels = new Set(outs.map((e) => String(e.label || "").trim()));
    if (outs.length < 2 || !labels.has("Да") || !labels.has("Нет")) {
      const missing = !labels.has("Нет") ? "Нет" : "Да";
      gaps.push({ id: n.id, missing });
    }
  }
  for (const g of gaps) {
    lines.push(`  gap${g.id}["Ветка '${g.missing}' не задана в 1С"]`);
    lines.push(`  ${nodeId(g.id)} -.->|"${g.missing}"| gap${g.id}`);
  }
  if (gaps.length) {
    lines.push(`  classDef gapNode fill:#fff3cd,stroke:#b8860b,stroke-dasharray:4 3;`);
    lines.push(`  class ${gaps.map((g) => `gap${g.id}`).join(",")} gapNode;`);
  }

  // Подсветка старта и завершения
  const starts = nodes.filter((n) => n.kind === "Старт").map((n) => nodeId(n.id));
  const ends   = nodes.filter((n) => n.kind === "Завершение").map((n) => nodeId(n.id));
  if (starts.length) {
    lines.push(`  classDef startNode fill:#d4f4d4,stroke:#2d7a2d,stroke-width:2px;`);
    lines.push(`  class ${starts.join(",")} startNode;`);
  }
  if (ends.length) {
    lines.push(`  classDef endNode fill:#f4d4d4,stroke:#7a2d2d,stroke-width:2px;`);
    lines.push(`  class ${ends.join(",")} endNode;`);
  }

  return lines.join("\n");
}

