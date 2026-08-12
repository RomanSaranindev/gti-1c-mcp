/**
 * stemmer.js — Стеммер для русского языка (алгоритм Портера, адаптация для 1С.БИТ)
 *
 * Без внешних зависимостей. Снижает словоформы к общему корню:
 *   "путевые" → "путев"
 *   "заявки"  → "заявк"
 *   "оплатить" → "оплат"
 *
 * Источник алгоритма: http://snowball.tartarus.org/algorithms/russian/stemmer.html
 * Реализация: упрощённая портация для использования в TF-IDF поиске.
 */

const VOWELS = new Set("аеёиоуыьэюя");

function isVowel(ch) {
  return VOWELS.has(ch);
}

function findRV(word) {
  // RV — после первого согласного
  let i = 0;
  while (i < word.length && !isVowel(word[i])) i++;
  // Пропускаем гласную
  i++;
  return i;
}

function findR1(word) {
  // R1 — первая позиция после первой пары (гласная + согласная)
  let i = 0;
  while (i < word.length && !isVowel(word[i])) i++;
  while (i < word.length && isVowel(word[i])) i++;
  return i;
}

// Списки окончаний (сортированы по убыванию длины — жадный поиск)
const PERFECTIVE_GERUND_1 = ["вшись", "вши", "вшем", "вше", "вшую", "вших", "вшим", "вшими", "вший", "вшего", "вшей", "вшему", "ввшую"];
const PERFECTIVE_GERUND_2 = ["ившись", "ившем", "ившей", "ивши", "ившую", "ивших", "ивший", "ившему", "ившими", "ившим", "ивший"];

const REFLEXIVE = ["ся", "сь"];

const ADJECTIVE = [
  "ими", "ыми", "ого", "ему", "ому", "ьего", "ьей", "ьему",
  "ьим", "ьими", "им", "ым", "ого", "ее", "ей", "ую", "юю",
  "ой", "ий", "ый", "ая", "яя", "ие", "ые", "ое", "её", "их", "ых",
];

const PARTICIPLE_1 = ["ем", "нн", "вш", "ющ", "щ"];
const PARTICIPLE_2 = ["ивш", "ывш", "ующ"];

const VERB_1 = [
  "ешь", "уешь", "ишь", "ете", "уете", "ите", "ует", "ет", "ит",
  "ють", "ают", "ют", "уют", "ят", "ят", "ить", "ать", "ять", "еть",
  "овать", "евать", "ывать", "ивать",
  "уй", "уйте", "йте", "ай", "яй",
  "ем", "им",
];
const VERB_2 = [
  "ить", "ыть", "ать", "ять", "еть", "уть",
  "ивать", "овать", "евать", "ывать",
  "ите", "ыте", "ете", "ите", "уете",
];

const NOUN = [
  "ами", "ями", "ием", "ием", "ием", "ий", "ия", "ие", "ий", "ье",
  "ьё", "иях", "ях", "ах", "ох", "ех", "ей", "ией", "ией",
  "и", "ы", "а", "я", "о", "е", "ё",
  "ию", "ию", "ию",
  "ом", "ем", "ём",
  "ам", "ям",
  "у", "ю",
  "ов", "ев", "ёв", "ей", "ий",
  "ость", "ости", "остей", "остям", "остями", "остях",
  "ение", "ения", "ению", "ением", "ений", "ениях", "ениям", "ениями",
  "ание", "ания", "анию", "анием", "аний", "аниях", "аниям", "аниями",
  "ка", "ки", "ке", "ку", "кой", "ком", "кам", "ках", "кой", "ками",
];

const SUPERLATIVE = ["ейш", "ейше"];
const DERIVATIONAL = ["ость", "ости"];

function endsWith(word, suffix) {
  return word.endsWith(suffix);
}

function tryReplace(word, suffixes, region) {
  for (const s of suffixes.sort((a, b) => b.length - a.length)) {
    if (word.length - s.length >= region && endsWith(word, s)) {
      return word.slice(0, word.length - s.length);
    }
  }
  return null;
}

/**
 * Возвращает основу слова (стем).
 * @param {string} word - слово в нижнем регистре
 * @returns {string} - стем слова
 */
export function stem(word) {
  if (!word || word.length <= 2) return word;

  // Только русские слова (содержат кириллицу)
  if (!/[а-яёА-ЯЁ]/.test(word)) return word;

  word = word.toLowerCase().replace(/ё/g, "е");

  const rv = findRV(word);

  // Шаг 1: убрать PERFECTIVE_GERUND или (REFLEXIVE?) + VERB или NOUN
  let result = tryReplace(word, PERFECTIVE_GERUND_2, rv);
  if (result === null) result = tryReplace(word, PERFECTIVE_GERUND_1, rv);

  if (result !== null) {
    word = result;
  } else {
    // Убрать REFLEXIVE
    let temp = tryReplace(word, REFLEXIVE, rv);
    const base = temp !== null ? temp : word;
    const baseRv = findRV(base);

    // Попробовать ADJECTIVE + PARTICIPLE
    let adj = tryReplace(base, ADJECTIVE, baseRv);
    if (adj !== null) {
      let part = tryReplace(adj, PARTICIPLE_1, findRV(adj));
      if (part !== null) { word = part; }
      else { word = adj; }
    } else {
      // Попробовать VERB
      let verb = tryReplace(base, VERB_2, baseRv);
      if (verb === null) verb = tryReplace(base, VERB_1, baseRv);
      if (verb !== null) { word = verb; }
      else {
        // NOUN
        let noun = tryReplace(base, NOUN, baseRv);
        if (noun !== null) { word = noun; }
        else { word = base; }
      }
    }
  }

  // Шаг 2: убрать И в RV
  const rv2 = findRV(word);
  if (word.length > rv2 && word.endsWith("и")) {
    word = word.slice(0, -1);
  }

  // Шаг 3: убрать DERIVATIONAL в R1
  const r1 = findR1(word);
  let der = tryReplace(word, DERIVATIONAL, r1);
  if (der !== null) word = der;

  // Шаг 4: убрать Ь или SUPERLATIVE + (нн→н)
  const rv3 = findRV(word);
  let sup = tryReplace(word, SUPERLATIVE, rv3);
  if (sup !== null) {
    word = sup;
    if (word.endsWith("нн")) word = word.slice(0, -1);
  }
  if (word.endsWith("ь") && word.length - 1 >= rv3) {
    word = word.slice(0, -1);
  }
  if (word.endsWith("нн") && word.length - 2 >= rv3) {
    word = word.slice(0, -1);
  }

  return word;
}

/**
 * Токенизирует текст и возвращает стемы (для индексирования и поиска).
 * @param {string} text
 * @param {Set<string>} stopwords
 * @returns {string[]}
 */
export function stemTokenize(text, stopwords) {
  return (text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !stopwords.has(t))
    .map((t) => stem(t))
    .filter((t) => t.length > 1);
}
