# AGENTS.md — Инструкция для ИИ-агента (AI Setup Guide)

Этот файл объясняет ИИ-модели (Claude, ChatGPT, Cursor, OpenCode и другим агентам), **что такое этот сервер**, **как его развернуть** и **как с ним работать**.

---

## Что такое gti-1c-mcp

`gti-1c-mcp` — это **MCP-сервер** (Model Context Protocol) для работы с корпоративной системой **1С:БИТ.СТРОИТЕЛЬСТВО (БИТ.ФИНАНС)**.

Он даёт ИИ-агенту доступ к:
- **73 инструкциям пользователя 1С.БИТ** — полнотекстовый и семантический поиск
- **122 профилям групп доступа** — подбор, объяснение, сравнение
- **RBAC-матрице ролей** — валидация, уровень согласования, поиск по роли
- **417 должностям** — маппинг должность → типовые профили (из реальных обезличенных данных)

Сервер работает **полностью офлайн** — не требует внешних API, LLM или облачных сервисов.

---

## Быстрый старт для ИИ-агента

### Шаг 1. Клонировать репозиторий

```bash
# GitHub (публичный):
git clone https://github.com/RomanSaranindev/gti-1c-mcp.git

# GitLab (внутренний корпоративный):
git clone https://gitlab.ide-spb.com/saraninrg/gti-1c-mcp.git

cd gti-1c-mcp
```

### Шаг 2. Установить зависимости

```bash
npm install
```

> Если корпоративный SSL блокирует npm:
> ```bash
> npm install --strict-ssl=false --ignore-scripts
> ```

### Шаг 3. Настроить окружение

```bash
# Linux/macOS:
cp .env.example .env

# Windows:
copy .env.example .env
```

Отредактировать `.env`:
```env
MCP_PORT=3031
MCP_API_TOKEN=замените-на-свой-токен
```

### Шаг 4. Запустить сервер

```bash
npm start
```

Проверить что сервер запустился:
```bash
curl http://localhost:3031/health
```

Ожидаемый ответ:
```json
{
  "status": "ok",
  "server": "gti-1c-mcp",
  "tools": ["list_instructions", "search_instructions", ...],
  "tfidf_index": { "docs_count": 73, "vocab_size": 7334, "ready": true }
}
```

### Шаг 5. Подключить к ИИ-клиенту

#### OpenCode / Kilo Code
Добавить в `~/.config/opencode/opencode.json`:
```json
{
  "mcp": {
    "gti-1c": {
      "type": "remote",
      "url": "http://localhost:3031/mcp",
      "headers": { "X-MCP-Token": "ваш-токен" },
      "enabled": true
    }
  }
}
```

#### Claude Desktop
В файл конфигурации (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "gti-1c": {
      "url": "http://localhost:3031/mcp",
      "headers": { "X-MCP-Token": "ваш-токен" }
    }
  }
}
```

#### Cursor / Continue / другие MCP-клиенты
URL: `http://localhost:3031/mcp`  
Заголовок: `X-MCP-Token: ваш-токен`

---

## Инструменты сервера (12 штук)

ИИ-агент может вызывать следующие инструменты:

### База знаний инструкций (73 документа)

| Инструмент | Когда использовать |
|---|---|
| `list_instructions` | Показать список всех инструкций. Параметры: `filter_code` (например `ИП-301`), `filter_keyword` |
| `search_instructions` | Keyword-поиск. Параметр: `query` — запрос на русском |
| `get_instruction` | Получить полный текст. Параметр: `id` — имя файла или код `ИП-301` |
| `semantic_search_instructions` | **Семантический поиск** (TF-IDF + cosine). Параметр: `query` — запрос свободным языком |

**Когда использовать семантический vs keyword:**
- `semantic_search_instructions` — когда пользователь спрашивает своими словами: _"как оформить расход бензина"_, _"что делать если документ не проводится"_
- `search_instructions` — когда пользователь знает конкретные термины: _"путевой лист"_, _"заправочная ведомость"_

### Профили доступа и RBAC

| Инструмент | Когда использовать |
|---|---|
| `suggest_access_profile` | Подобрать профиль по описанию задач. Параметр: `request_text` — что делает сотрудник. Режим: `single` или `multi` |
| `get_roles_matrix` | Получить матрицу ролей. Параметры-фильтры: `filter_requires_accounting`, `filter_requires_transport`, `search_keyword` |
| `validate_roles` | Проверить набор ролей. Параметр: `roles` — массив строк |
| `get_approval_level` | Узнать уровень согласования. Параметр: `roles` — массив ролей |
| `explain_profile` | **Объяснить профиль на языке бизнеса**. Параметр: `profile_id` — id или часть названия профиля |
| `search_by_role` | **Найти профиль по роли 1С**. Параметр: `role_name` — название роли (частичное совпадение) |

### Маппинг должность → профили

| Инструмент | Когда использовать |
|---|---|
| `suggest_profile_by_job` | Типовые профили по должности. Параметры: `job_title`, `min_pct` (порог %, default 40), `limit` |
| `list_jobs` | Список должностей с фильтром. Параметры: `filter` (подстрока), `limit` |

---

## Типичные сценарии использования

### Сценарий 1: Новый сотрудник — подобрать доступ

```
Пользователь: "Нужно выдать доступ новому кладовщику"

Агент делает:
1. suggest_profile_by_job(job_title="кладовщик") → типовые профили из реальных данных
2. suggest_access_profile(request_text="кладовщик — приходные ордера, расходные ордера, заявки на МПЗ") → профили из RBAC
3. explain_profile(profile_id="...") → что увидит сотрудник в 1С
4. get_approval_level(roles=[...]) → кто должен подписать заявку
```

### Сценарий 2: Найти инструкцию

```
Пользователь: "Как создать путевой лист?"

Агент делает:
1. semantic_search_instructions(query="создать путевой лист") → ИП-301
2. get_instruction(id="ИП-301...") → полный текст инструкции
```

### Сценарий 3: Администратор видит роль в 1С

```
Пользователь: "Что значит роль бит_ИсполнительКазначейства?"

Агент делает:
1. search_by_role(role_name="бит_ИсполнительКазначейства") → профили и бизнес-функции
2. explain_profile(profile_id="PROFILE_БИТ_ИСПОЛНИТЕЛЬ_КАЗНАЧЕЙСТВА") → объяснение
```

### Сценарий 4: Проверить набор ролей перед заявкой

```
Пользователь: "Проверь правильность ролей: бит_Казначей, ЗапускТонкогоКлиента"

Агент делает:
1. validate_roles(roles=["бит_Казначей", "ЗапускТонкогоКлиента"]) → отсутствующие обязательные роли
2. get_approval_level(roles=[...]) → standard/accounting/transport/transport_accounting
```

---

## Административные эндпоинты

| Эндпоинт | Метод | Авторизация | Назначение |
|---|---|---|---|
| `/health` | GET | Нет | Состояние сервера, статус индекса |
| `/` | GET | Нет | Справка по подключению |
| `/mcp` | POST | X-MCP-Token | MCP-протокол |
| `/reload` | POST | X-MCP-Token | Горячая перезагрузка базы знаний |

### Горячая перезагрузка (без рестарта сервера)

```bash
curl -X POST http://localhost:3031/reload \
  -H "X-MCP-Token: ваш-токен"
```

Используй после добавления новых `.md` файлов в `knowledge/instructions/`.  
Сервер также автоматически перезагружает базу при изменении файлов (`fs.watch`).

---

## Структура проекта

```
gti-1c-mcp/
├── src/
│   ├── server.js           # Точка входа: HTTP + MCP (12 инструментов)
│   ├── knowledge_base.js   # Загрузка .md файлов, keyword-поиск, fs.watch
│   ├── vector_search.js    # TF-IDF + cosine similarity (семантический поиск)
│   ├── rbac_matrix.js      # RBAC-матрица (11 бизнес-функций, 122 профиля)
│   └── job_profiles.js     # Маппинг 417 должностей → типовые профили
├── knowledge/
│   └── instructions/       # 73 .md файла с инструкциями 1С.БИТ
│       ├── ИП-301.*.md     # Оригинальные инструкции (ИП-XXX)
│       └── wiki-*.md       # Инструкции с корпоративного wiki
├── .env.example            # Шаблон переменных окружения
├── .env                    # Локальные секреты (не коммитить!)
├── Dockerfile              # Docker-образ
├── docker-compose.yml      # Docker Compose конфиг
├── package.json
├── README.md               # Документация для людей
└── AGENTS.md               # Этот файл — для ИИ-агентов
```

---

## Добавление новых инструкций в базу знаний

Чтобы добавить новую инструкцию:

1. Создать `.md` файл в `knowledge/instructions/`
2. Формат файла:

```markdown
# Название инструкции

Код инструкции: `ИП-XXX`
Источник: `название источника`
Тип: INSTRUCTION

## Раздел 1

Текст инструкции...

## Раздел 2

...
```

3. Сервер автоматически подхватит файл через `fs.watch` (debounce 500ms).
4. Или вручную: `POST /reload` с токеном.

---

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `MCP_PORT` | `3031` | Порт HTTP-сервера |
| `MCP_API_TOKEN` | `gti-mcp-token-2024` | Токен авторизации (обязательно смените!) |
| `KNOWLEDGE_DIR` | `knowledge/instructions` | Путь к папке с .md инструкциями |

---

## Запуск через Docker

```bash
# Сборка и запуск:
docker-compose up -d

# Просмотр логов:
docker-compose logs -f

# Остановка:
docker-compose down
```

---

## Автозапуск на Windows (для постоянной работы)

```powershell
# Запустить PowerShell от администратора:
$action = New-ScheduledTaskAction `
    -Execute "node" `
    -Argument "src/server.js" `
    -WorkingDirectory "C:\путь\к\gti-1c-mcp"

$trigger = New-ScheduledTaskTrigger -AtStartup

Register-ScheduledTask `
    -TaskName "gti-1c-mcp" `
    -Action $action `
    -Trigger $trigger `
    -RunLevel Highest `
    -Force
```

---

## Безопасность

- **Не коммитить** `.env` и `Employee database.xlsx` — они в `.gitignore`
- `MCP_API_TOKEN` — обязательно сменить перед деплоем вне localhost
- `/health` и `/` открыты без токена (только чтение статуса)
- Все остальные эндпоинты требуют заголовок `X-MCP-Token`

---

## Типичные ошибки

| Симптом | Причина | Решение |
|---|---|---|
| `401 Unauthorized` | Неверный или отсутствует токен | Добавить заголовок `X-MCP-Token` |
| `npm install` падает с SSL | Корпоративный прокси | `npm install --strict-ssl=false --ignore-scripts` |
| `tfidf_index.ready: false` | Индекс ещё строится | Подождать 3–5 сек после старта |
| Инструкция не находится | Файл добавлен после старта | `POST /reload` или подождать fs.watch |
| Сервер не стартует | Порт занят | Сменить `MCP_PORT` в `.env` |

---

## Контакты и поддержка

- Репозиторий GitHub: https://github.com/RomanSaranindev/gti-1c-mcp
- Репозиторий GitLab: https://gitlab.ide-spb.com/saraninrg/gti-1c-mcp
- Вопросы: Саранин Роман Геннадьевич (Чита)
