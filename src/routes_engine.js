/**
 * routes_engine.js  v2.0
 * Движок маршрутов согласования 1С:БИТ.ФИНАНС
 *
 * Модель данных:
 *   record_type = "Роль"  — запись с постфиксом " БЕ" (is_be_role=true).
 *                           Привязывается к пользователям конкретной бизнес-единицы в 1С.
 *   record_type = "Виза"  — запись без постфикса (is_be_role=false).
 *                           Конкретная должность, группа, подразделение.
 *
 * Экспортируемые функции:
 *   reloadDb            — сброс кэша БД (при hot-reload)
 *   normalizeDocType    — нормализация названия документа
 *   normalizeOrg        — нечёткий поиск организации
 *   suggestRoute        — подбор цепочки согласования по параметрам
 *   getRoute            — полный маршрут (все варианты/шаги) без фильтрации
 *   compareRoutes       — сравнение маршрутов двух организаций
 *   listRoutes          — список доступных маршрутов
 *   validateRouteParams — валидация параметров перед подбором
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '..', 'knowledge', 'routes', 'routes_db.json');

// ─── Загрузка и кэширование БД ───────────────────────────────────────────────

let _db = null;

function getDb() {
  if (!_db) {
    if (!fs.existsSync(DB_PATH)) throw new Error(`База маршрутов не найдена: ${DB_PATH}`);
    _db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  }
  return _db;
}

export function reloadDb() {
  _db = null;
  return getDb();
}

// ─── Алиасы типов документов ─────────────────────────────────────────────────

const DOC_TYPE_ALIASES = {
  'конкурентная карта':               'КонкурентнаяКарта',
  'конкурентной карты':               'КонкурентнаяКарта',
  'цс-001': 'КонкурентнаяКарта', 'цс001': 'КонкурентнаяКарта',

  'заявка на мпз':  'ЗаявкаНаМПЗ', 'заявка мпз': 'ЗаявкаНаМПЗ', 'мпз': 'ЗаявкаНаМПЗ',
  'цс-002': 'ЗаявкаНаМПЗ',          'цс002': 'ЗаявкаНаМПЗ',

  'заявка на затраты': 'ЗаявкаНаЗатраты', 'затраты': 'ЗаявкаНаЗатраты',
  'цс-003': 'ЗаявкаНаЗатраты',       'цс003': 'ЗаявкаНаЗатраты',

  'заявка на расход дс':       'ЗаявкаНаРасходДС',
  'заявка на расходование дс': 'ЗаявкаНаРасходДС',
  'расход дс': 'ЗаявкаНаРасходДС',
  'цс-004': 'ЗаявкаНаРасходДС',      'цс004': 'ЗаявкаНаРасходДС',

  'реестр платежей': 'РеестрПлатежей', 'реестр': 'РеестрПлатежей',
  'цс-005': 'РеестрПлатежей',         'цс005': 'РеестрПлатежей',

  'корректировка контрольных значений': 'КорректировкаКонтрольныхЗначений',
  'корректировка кв': 'КорректировкаКонтрольныхЗначений',
  'цс-006': 'КорректировкаКонтрольныхЗначений', 'цс006': 'КорректировкаКонтрольныхЗначений',

  'заказ поставщику': 'ЗаказПоставщику', 'заказ': 'ЗаказПоставщику',
};

export function normalizeDocType(raw) {
  if (!raw) return null;
  return DOC_TYPE_ALIASES[raw.trim().toLowerCase()] || raw;
}

export function normalizeOrg(raw) {
  if (!raw) return null;
  const db = getDb();
  if (db.organizations[raw]) return raw;
  const lower = raw.toLowerCase();
  for (const [key, data] of Object.entries(db.organizations)) {
    if (
      key.toLowerCase().includes(lower) ||
      (data.code || '').toLowerCase().includes(lower) ||
      (data.full_name || '').toLowerCase().includes(lower)
    ) return key;
  }
  return null;
}

/**
 * Найти ключ маршрута в routes-объекте по типу документа.
 * В БД маршрут может быть записан под ключом 'КонкурентнаяКарта' или 'ЦС-001' и т.д.
 */
function resolveRouteKey(orgRoutes, docType) {
  if (!docType) return null;
  if (orgRoutes[docType]) return docType;
  for (const [key, route] of Object.entries(orgRoutes)) {
    if (
      route.doc_type === docType ||
      route.doc_type_label === docType ||
      (route.code || '').toLowerCase() === docType.toLowerCase() ||
      key.toLowerCase() === docType.toLowerCase()
    ) return key;
  }
  return null;
}

// ─── Форматирование ───────────────────────────────────────────────────────────

function formatCondition(cond) {
  if (!cond) return '';
  const ops = { '=': '=', '!=': '≠', '<': '<', '>': '>', '<=': '≤', '>=': '≥',
                'IN': 'входит в', 'NOT IN': 'не входит в', 'CONTAINS': 'содержит' };
  if (cond.field === 'Всегда' && cond.value === true) return 'Всегда';
  const op  = ops[cond.op] || cond.op;
  const val = Array.isArray(cond.value) ? `[${cond.value.join(', ')}]` : cond.value;
  return `${cond.field} ${op} ${val}`;
}

function matchConditions(conditions, params) {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every(cond => {
    if (cond.field === 'Всегда' && cond.value === true) return true;
    const paramVal = params[cond.field];
    if (paramVal === undefined || paramVal === null) return true;
    switch (cond.op) {
      case '=':       return String(paramVal).toLowerCase() === String(cond.value).toLowerCase();
      case '!=':      return String(paramVal).toLowerCase() !== String(cond.value).toLowerCase();
      case '>':       return Number(paramVal) > Number(cond.value);
      case '>=':      return Number(paramVal) >= Number(cond.value);
      case '<':       return Number(paramVal) < Number(cond.value);
      case '<=':      return Number(paramVal) <= Number(cond.value);
      case 'IN':      return Array.isArray(cond.value) &&
                             cond.value.some(v => String(v).toLowerCase() === String(paramVal).toLowerCase());
      case 'NOT IN':  return !Array.isArray(cond.value) ||
                             !cond.value.some(v => String(v).toLowerCase() === String(paramVal).toLowerCase());
      case 'CONTAINS': return String(paramVal).toLowerCase().includes(String(cond.value).toLowerCase());
      default: return true;
    }
  });
}

/**
 * Форматирует один sub-шаг:
 * [Роль] — с тегом [БЕ], [Виза] — без тега
 */
function formatSub(sub, orgCode) {
  const rt        = sub.record_type || (sub.is_be_role ? 'Роль' : 'Виза');
  const roleLabel = rt === 'Роль'
    ? `**[Роль]** ${sub.role} \`[${orgCode}]\``
    : `[Виза] ${sub.role}`;
  const conds = (sub.conditions || [])
    .map(formatCondition)
    .filter(c => c && c !== 'Всегда')
    .join(', ');
  const condStr = conds ? ` _(${conds})_` : '';
  const note    = sub.note ? ` — ${sub.note}` : '';
  return `  • ${roleLabel}${condStr}${note}`;
}

function formatStep(step, orgCode, idx) {
  const typeLabel = step.type === 'Создание'    ? '📝 Создание'
                  : step.type === 'Утверждение' ? '✅ Утверждение'
                  : '🔄 Согласование';

  const label = step.label && step.label !== step.type
    ? ` — ${step.label}` : '';

  if (step.steps_parallel) {
    const lines = [`**Шаг ${idx}. ${typeLabel}${label}**`];
    for (const sub of step.steps_parallel) {
      lines.push(formatSub(sub, orgCode));
    }
    return lines.join('\n');
  } else {
    const rt        = step.record_type || (step.is_be_role ? 'Роль' : 'Виза');
    const roleLabel = rt === 'Роль'
      ? `**[Роль]** ${step.role} \`[${orgCode}]\``
      : `[Виза] ${step.role}`;
    const note      = step.note ? ` — _${step.note}_` : '';
    return `**Шаг ${idx}. ${typeLabel}** → ${roleLabel}${note}`;
  }
}

// ─── suggest_route ────────────────────────────────────────────────────────────

export function suggestRoute(params) {
  const db      = getDb();
  const orgKey  = normalizeOrg(params.org);
  const docType = normalizeDocType(params.doc_type);

  if (!orgKey) {
    return { error: true, message: `Организация "${params.org}" не найдена. Доступные: ${Object.keys(db.organizations).join(', ')}` };
  }

  const orgData  = db.organizations[orgKey];
  const routeKey = resolveRouteKey(orgData.routes, docType);

  if (!routeKey) {
    const available = Object.entries(orgData.routes)
      .map(([k, r]) => `${r.code || k} (${r.doc_type_label})`).join(', ');
    return { error: true, message: `Документ "${params.doc_type}" не найден для ${orgKey}. Доступные: ${available}` };
  }

  const routeDef = orgData.routes[routeKey];

  // Выбор варианта
  let variant = routeDef.variants[0];
  if (params.project && routeDef.variants.length > 1) {
    const found = routeDef.variants.find(v =>
      (v.variant_label || '').toLowerCase().includes(params.project.toLowerCase()) ||
      (v.project || '').toLowerCase() === params.project.toLowerCase()
    );
    if (found) variant = found;
  }

  // Параметры фильтра
  const fp = {
    СуммаДокумента:       params.amount        !== undefined ? Number(params.amount) : undefined,
    ЦФО:                  params.cfo,
    Проект:               params.project,
    ВидОперации:          params.operation_type,
    СтатьяДДС:            params.dds_article,
    ТипТК:                params.tk_type,
    ОтветственныйВЗаказе: params.responsible,
    Всегда:               true,
  };

  // Фильтрация шагов
  const chain = [];
  let idx = 1;
  for (const step of variant.steps) {
    if (step.steps_parallel) {
      const matched = step.steps_parallel.filter(sub => matchConditions(sub.conditions, fp));
      if (matched.length > 0) { chain.push({ ...step, steps_parallel: matched, _idx: idx++ }); }
    } else {
      if (matchConditions(step.conditions, fp)) { chain.push({ ...step, _idx: idx++ }); }
    }
  }

  // Формируем заголовок
  const orgCode = orgData.code || orgKey;
  const lines = [
    `## Маршрут согласования`,
    `**Организация:** ${orgData.full_name} (${orgCode})`,
    `**Документ:** ${routeDef.doc_type_label} (${routeDef.code || routeKey})`,
    `**Вариант:** ${variant.variant_label}`,
  ];
  if (params.amount        !== undefined) lines.push(`**Сумма:** ${Number(params.amount).toLocaleString('ru-RU')} руб.`);
  if (params.cfo)            lines.push(`**ЦФО:** ${params.cfo}`);
  if (params.project)        lines.push(`**Проект:** ${params.project}`);
  if (params.operation_type) lines.push(`**Вид операции:** ${params.operation_type}`);
  if (params.tk_type)        lines.push(`**Тип ТК:** ${params.tk_type}`);

  lines.push('', '---');

  // Легенда
  lines.push('> **[Роль]** `[БЕ]` — роль привязывается к пользователям данной бизнес-единицы в 1С.');
  lines.push('> **[Виза]** — конкретная должность/группа, не привязанная к БЕ.');
  lines.push('');

  if (chain.length === 0) {
    lines.push('_Нет подходящих шагов для указанных параметров. Проверьте входные данные._');
  } else {
    for (const step of chain) {
      lines.push(formatStep(step, orgCode, step._idx));
      lines.push('');
    }
  }

  // Сводка ролей БЕ
  const beRoles = [];
  for (const step of chain) {
    for (const sub of (step.steps_parallel || [step])) {
      const rt = sub.record_type || (sub.is_be_role ? 'Роль' : 'Виза');
      if (rt === 'Роль' && sub.role && !beRoles.includes(sub.role)) beRoles.push(sub.role);
    }
  }
  if (beRoles.length > 0) {
    lines.push('---');
    lines.push(`**Роли БЕ** (в 1С назначаются пользователям ${orgData.full_name}):`);
    beRoles.forEach(r => lines.push(`- ${r}`));
  }

  return {
    error: false,
    org: orgKey, org_full: orgData.full_name,
    doc_type: routeKey, doc_type_label: routeDef.doc_type_label,
    variant_id: variant.variant_id, variant_label: variant.variant_label,
    steps_count: chain.length, be_roles: beRoles,
    chain,
    formatted: lines.join('\n'),
  };
}

// ─── getRoute ─────────────────────────────────────────────────────────────────

export function getRoute(params) {
  const db      = getDb();
  const orgKey  = normalizeOrg(params.org);
  const docType = normalizeDocType(params.doc_type);

  if (!orgKey) return { error: true, message: `Организация "${params.org}" не найдена.` };

  const orgData = db.organizations[orgKey];

  if (docType) {
    const routeKey = resolveRouteKey(orgData.routes, docType);
    if (!routeKey) return { error: true, message: `Документ "${params.doc_type}" не найден для ${orgKey}.` };
    return { error: false, org: orgKey, org_full: orgData.full_name, doc_type: docType, route: orgData.routes[routeKey] };
  }

  return {
    error: false, org: orgKey, org_full: orgData.full_name,
    routes: Object.fromEntries(
      Object.entries(orgData.routes).map(([dt, r]) => [dt, {
        code: r.code, doc_type_label: r.doc_type_label,
        variants_count: r.variants.length,
      }])
    ),
  };
}

// ─── compareRoutes ────────────────────────────────────────────────────────────

export function compareRoutes(params) {
  const db      = getDb();
  const org1Key = normalizeOrg(params.org1);
  const org2Key = normalizeOrg(params.org2);
  const docType = normalizeDocType(params.doc_type);

  if (!org1Key) return { error: true, message: `Организация 1 "${params.org1}" не найдена.` };
  if (!org2Key) return { error: true, message: `Организация 2 "${params.org2}" не найдена.` };
  if (!docType) return { error: true, message: 'Тип документа не указан.' };

  const org1   = db.organizations[org1Key];
  const org2   = db.organizations[org2Key];
  const rKey1  = resolveRouteKey(org1.routes, docType);
  const rKey2  = resolveRouteKey(org2.routes, docType);
  const route1 = rKey1 ? org1.routes[rKey1] : null;
  const route2 = rKey2 ? org2.routes[rKey2] : null;

  if (!route1 && !route2) {
    return { error: true, message: `Маршрут "${docType}" не найден ни у одной из организаций.` };
  }

  function getEntries(route) {
    if (!route) return { roles: [], visas: [] };
    const roles = new Set(), visas = new Set();
    for (const v of route.variants) {
      for (const step of v.steps) {
        for (const sub of (step.steps_parallel || [step])) {
          const rt = sub.record_type || (sub.is_be_role ? 'Роль' : 'Виза');
          if (sub.role) { rt === 'Роль' ? roles.add(sub.role) : visas.add(sub.role); }
        }
      }
    }
    return { roles: [...roles], visas: [...visas] };
  }

  const e1 = getEntries(route1);
  const e2 = getEntries(route2);

  const commonRoles  = e1.roles.filter(r => e2.roles.includes(r));
  const commonVisas  = e1.visas.filter(r => e2.visas.includes(r));
  const onlyRoles1   = e1.roles.filter(r => !e2.roles.includes(r));
  const onlyRoles2   = e2.roles.filter(r => !e1.roles.includes(r));
  const onlyVisas1   = e1.visas.filter(r => !e2.visas.includes(r));
  const onlyVisas2   = e2.visas.filter(r => !e1.visas.includes(r));

  const na = '—';
  const lines = [
    `## Сравнение маршрутов: ${docType}`,
    `| Параметр | ${org1Key} | ${org2Key} |`,
    `| --- | --- | --- |`,
    `| Организация | ${org1.full_name} | ${org2.full_name} |`,
    `| Маршрут найден | ${route1 ? '✅' : '❌'} | ${route2 ? '✅' : '❌'} |`,
    `| Вариантов | ${route1 ? route1.variants.length : na} | ${route2 ? route2.variants.length : na} |`,
    `| Ролей БЕ | ${e1.roles.length} | ${e2.roles.length} |`,
    `| Виз | ${e1.visas.length} | ${e2.visas.length} |`,
    `| Общих ролей БЕ | ${commonRoles.length} | ${commonRoles.length} |`,
    `| Общих виз | ${commonVisas.length} | ${commonVisas.length} |`,
    '',
  ];

  if (commonRoles.length > 0) {
    lines.push(`### ✅ Общие Роли БЕ (${commonRoles.length})`);
    commonRoles.forEach(r => lines.push(`- **[Роль]** ${r}`));
    lines.push('');
  }
  if (commonVisas.length > 0) {
    lines.push(`### ✅ Общие Визы (${commonVisas.length})`);
    commonVisas.forEach(r => lines.push(`- [Виза] ${r}`));
    lines.push('');
  }
  if (onlyRoles1.length > 0) {
    lines.push(`### Только Роли БЕ у ${org1Key} (${onlyRoles1.length})`);
    onlyRoles1.forEach(r => lines.push(`- **[Роль]** ${r}`));
    lines.push('');
  }
  if (onlyRoles2.length > 0) {
    lines.push(`### Только Роли БЕ у ${org2Key} (${onlyRoles2.length})`);
    onlyRoles2.forEach(r => lines.push(`- **[Роль]** ${r}`));
    lines.push('');
  }
  if (onlyVisas1.length > 0) {
    lines.push(`### Только Визы у ${org1Key} (${onlyVisas1.length})`);
    onlyVisas1.forEach(r => lines.push(`- [Виза] ${r}`));
    lines.push('');
  }
  if (onlyVisas2.length > 0) {
    lines.push(`### Только Визы у ${org2Key} (${onlyVisas2.length})`);
    onlyVisas2.forEach(r => lines.push(`- [Виза] ${r}`));
    lines.push('');
  }

  // Структура шагов (первый вариант)
  if (route1 && route2) {
    const steps1 = route1.variants[0].steps;
    const steps2 = route2.variants[0].steps;
    lines.push('### Структура шагов (первый вариант)');
    lines.push(`| # | ${org1Key} | ${org2Key} | ∑Виз/Ролей |`);
    lines.push('| --- | --- | --- | --- |');
    const maxSteps = Math.max(steps1.length, steps2.length);
    for (let i = 0; i < maxSteps; i++) {
      const s1 = steps1[i];
      const s2 = steps2[i];
      const l1 = s1 ? `${s1.type}${s1.label && s1.label !== s1.type ? ': ' + s1.label : ''}` : na;
      const l2 = s2 ? `${s2.type}${s2.label && s2.label !== s2.type ? ': ' + s2.label : ''}` : na;
      const cnt1 = s1 ? (s1.steps_parallel || [s1]).length : 0;
      const cnt2 = s2 ? (s2.steps_parallel || [s2]).length : 0;
      const match = (l1 === l2) ? '✅' : '⚠️';
      lines.push(`| ${i+1} | ${l1} ${match} | ${l2} | ${cnt1} / ${cnt2} |`);
    }
  }

  return {
    error: false, org1: org1Key, org2: org2Key, doc_type: docType,
    common_roles: commonRoles, common_visas: commonVisas,
    only_roles_org1: onlyRoles1, only_roles_org2: onlyRoles2,
    only_visas_org1: onlyVisas1, only_visas_org2: onlyVisas2,
    formatted: lines.join('\n'),
  };
}

// ─── listRoutes ───────────────────────────────────────────────────────────────

export function listRoutes(params) {
  const db        = getDb();
  const orgFilter = params?.org ? normalizeOrg(params.org) : null;

  if (params?.org && !orgFilter) {
    return { error: true, message: `Организация "${params.org}" не найдена.` };
  }

  const entries = orgFilter
    ? [[orgFilter, db.organizations[orgFilter]]]
    : Object.entries(db.organizations);

  const lines  = ['## Доступные маршруты согласования', ''];
  const result = [];

  for (const [orgKey, orgData] of entries) {
    lines.push(`### ${orgData.full_name} (${orgData.code || orgKey})`);
    const orgRoutes = [];
    for (const [dt, r] of Object.entries(orgData.routes)) {
      const variants = r.variants.map(v => v.variant_label).join(', ');
      lines.push(`- **${r.code || dt}** — ${r.doc_type_label} (вариантов: ${r.variants.length}: ${variants})`);
      orgRoutes.push({ doc_type: dt, code: r.code, label: r.doc_type_label, variants_count: r.variants.length });
    }
    lines.push('');
    result.push({ org: orgKey, org_full: orgData.full_name, routes: orgRoutes });
  }

  return { error: false, total_orgs: entries.length, organizations: result, formatted: lines.join('\n') };
}

// ─── validateRouteParams ─────────────────────────────────────────────────────

export function validateRouteParams(params) {
  const db     = getDb();
  const issues  = [];
  const warnings = [];

  const orgKey = params.org ? normalizeOrg(params.org) : null;
  if (!params.org) {
    issues.push('Не указана организация (параметр org)');
  } else if (!orgKey) {
    issues.push(`Организация "${params.org}" не найдена. Доступные: ${Object.keys(db.organizations).join(', ')}`);
  }

  if (!params.doc_type) {
    issues.push('Не указан тип документа (параметр doc_type)');
  } else if (orgKey && db.organizations[orgKey]) {
    const dt = normalizeDocType(params.doc_type);
    if (!resolveRouteKey(db.organizations[orgKey].routes, dt || params.doc_type)) {
      const avail = Object.entries(db.organizations[orgKey].routes)
        .map(([k, r]) => `${r.code || k} (${r.doc_type_label})`).join(', ');
      issues.push(`Документ "${params.doc_type}" не найден для ${orgKey}. Доступные: ${avail}`);
    }
  }

  if (params.amount !== undefined) {
    const amt = Number(params.amount);
    if (isNaN(amt) || amt < 0) issues.push(`Некорректная сумма: ${params.amount}`);
    else if (amt === 0) warnings.push('Сумма = 0 — пороговые условия могут сработать некорректно');
  } else {
    warnings.push('Сумма не указана (amount) — условия по сумме не применяются');
  }

  const lines = [
    issues.length === 0 ? '✅ Параметры корректны' : `❌ Ошибки (${issues.length}):`,
    ...issues.map(e => `  - ${e}`),
    ...(warnings.length > 0 ? [`\n⚠️ Предупреждения:`, ...warnings.map(w => `  - ${w}`)] : []),
  ].filter(Boolean);

  return {
    error: false, valid: issues.length === 0, issues, warnings,
    normalized: { org: orgKey, doc_type: normalizeDocType(params.doc_type), amount: params.amount !== undefined ? Number(params.amount) : undefined },
    formatted: lines.join('\n'),
  };
}
