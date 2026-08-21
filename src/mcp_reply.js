/**
 * mcp_reply.js — хелперы формирования ответов MCP-инструментов.
 *
 * Паттерн `return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }`
 * повторялся в server.js 50 раз, обёртка try/catch с formatOnecError — 8 раз.
 * Здесь собраны общие формы, чтобы обработчики инструментов содержали
 * только бизнес-логику.
 */

import { formatOnecError, getOnecConfig, unwrapOnecPayload } from "./onec_client.js";

/**
 * Стандартный текстовый ответ MCP с JSON-телом.
 *
 * @param {object} payload — тело ответа
 * @returns {{content: Array<{type: string, text: string}>}}
 */
export function jsonReply(payload) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(payload, null, 2),
    }],
  };
}

/**
 * Ответ с пометкой источника «живая база 1С».
 * Заголовок source + onec_url раньше дублировался в 8 инструментах.
 *
 * @param {object} payload — тело ответа (обычно результат unwrapOnecPayload)
 * @param {object} [extra] — дополнительные поля перед payload (например filters)
 * @returns {{content: Array<{type: string, text: string}>}}
 */
export function liveReply(payload, extra = {}) {
  return jsonReply({
    source: "1C:БИТ.ФИНАНС (живая база)",
    onec_url: getOnecConfig().url,
    ...extra,
    ...payload,
  });
}

/**
 * Ответ об ошибке в едином виде.
 * Формат намеренно совместим со старым `{ error, message, hint }`,
 * чтобы не ломать существующие промпты агентов.
 *
 * @param {string} code — машиночитаемый код, например "NotFound"
 * @param {string} message — человекочитаемое описание
 * @param {object} [extra] — дополнительные поля (hint, requested_query и т.п.)
 */
export function errorReply(code, message, extra = {}) {
  return jsonReply({ error: code, message, ...extra });
}

/**
 * Оборачивает обработчик инструмента 1С в try/catch с единым форматом ошибки.
 *
 * Было в каждом из 8 инструментов:
 *   async (args) => {
 *     try { ... }
 *     catch (err) {
 *       return { content: [{ type: "text", text: formatOnecError(err, "подсказка") }] };
 *     }
 *   }
 *
 * Стало:
 *   onecTool(async (args) => { ... }, "подсказка")
 *
 * @param {(args: object) => Promise<object>} handler — тело инструмента
 * @param {string} [hint] — подсказка, добавляемая к тексту ошибки
 * @returns {(args: object) => Promise<object>}
 */
export function onecTool(handler, hint = "") {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return {
        content: [{ type: "text", text: formatOnecError(err, hint) }],
      };
    }
  };
}

/**
 * Комбинация onecTool + liveReply для самого частого случая:
 * «вызвать инструмент 1С и вернуть его payload с пометкой источника».
 *
 * @param {(args: object) => Promise<object>} call — функция, вызывающая callOnecTool
 * @param {string} [hint] — подсказка при ошибке
 * @param {(args: object) => object} [extraFields] — доп. поля ответа по аргументам
 */
export function onecPassthrough(call, hint = "", extraFields = null) {
  return onecTool(async (args) => {
    const result = await call(args);
    const extra = extraFields ? extraFields(args) : {};
    return liveReply(unwrapOnecPayload(result), extra);
  }, hint);
}
