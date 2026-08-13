/**
 * JOB_PROFILES_MAP — маппинг «должность → типовые профили доступа»
 *
 * Источник данных: knowledge/job_profiles.json
 * (сгенерирован из Employee database.xlsx, обезличенные данные)
 *
 * Данные хранятся в отдельном JSON-файле — это ускоряет холодный старт
 * по сравнению с хранением в виде JS-литерала (~108 000 строк).
 * JSON.parse на V8 в 3-5 раз быстрее разбора эквивалентного JS-кода.
 *
 * Загрузка ленивая: при первом обращении к любой из функций.
 * Критерий «типового» профиля: встречается у >= 40% сотрудников данной должности.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'knowledge', 'job_profiles.json');

// Ленивый кэш — загружается один раз при первом вызове
let _map = null;

function getMap() {
  if (!_map) {
    if (!fs.existsSync(DATA_PATH)) {
      process.stderr.write(`⚠️  job_profiles.json не найден: ${DATA_PATH}\n`);
      _map = {};
    } else {
      _map = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    }
  }
  return _map;
}

// Экспортируем прокси-объект для обратной совместимости (server.js использует JOB_PROFILES_MAP напрямую)
export const JOB_PROFILES_MAP = new Proxy({}, {
  get(_, key) { return getMap()[key]; },
  has(_, key) { return key in getMap(); },
  ownKeys()   { return Object.keys(getMap()); },
  getOwnPropertyDescriptor(_, key) {
    const v = getMap()[key];
    return v !== undefined ? { value: v, writable: false, enumerable: true, configurable: true } : undefined;
  },
});

/**
 * Проверяет, является ли запись аномальной (технический мусор или слишком малая выборка).
 */
export function checkJobAnomaly(jobTitle, data) {
  if (jobTitle.includes('<Объект не найден>')) {
    return { is_anomaly: true, reason: 'technical_garbage' };
  }
  if (data.total_persons < 3) {
    return { is_anomaly: true, reason: 'insufficient_sample' };
  }
  const profiles = data.typical_profiles || [];
  if (
    profiles.length >= 10 &&
    profiles.every((p) => p.pct === 100.0) &&
    data.total_persons <= 10
  ) {
    return { is_anomaly: true, reason: 'all_profiles_100pct' };
  }
  return { is_anomaly: false, reason: null };
}

/**
 * Найти должности по подстроке (нечёткий поиск).
 */
export function findJobs(query) {
  const q = query.toLowerCase();
  return Object.keys(getMap()).filter(
    (job) => job.toLowerCase().includes(q) && !job.includes('<Объект не найден>')
  );
}

/**
 * Получить типовые профили для конкретной должности.
 */
export function getJobProfiles(jobTitle) {
  return getMap()[jobTitle] || null;
}

/**
 * Нечёткий поиск: по подстроке возвращает данные первой совпавшей должности.
 */
export function suggestByJobQuery(query) {
  const matches = findJobs(query);
  if (matches.length === 0) return null;
  const job = matches[0];
  return { job, data: getMap()[job], all_matches: matches };
}
