# gti-1c-mcp

MCP-сервер (Model Context Protocol) для **1С:БИТ / БИТ.СТРОИТЕЛЬСТВО**.

Три независимых блока:
- **База знаний инструкций** — полнотекстовый поиск и выдача 73 инструкций пользователя 1С.БИТ
- **Профили доступа RBAC** — keyword-подбор профиля группы доступа, матрица ролей, валидация, уровень согласования
- **Маппинг должность → профили** — типовые профили доступа по должности на основе реальных обезличенных данных (417 должностей)

Не содержит LLM-зависимостей и логики провижининга заявок — это отдельный сервис.

---

## Репозитории

| Платформа | URL |
|---|---|
| GitHub | https://github.com/RomanSaranindev/gti-1c-mcp |
| GitLab | https://gitlab.ide-spb.com/saraninrg/gti-1c-mcp |

---

## Инструменты (22)

### База знаний

| Инструмент | Назначение |
|---|---|
| `list_instructions` | Список всех инструкций (фильтры по коду/ключевому слову) |
| `search_instructions` | Keyword-поиск (scoring по TF + позиции) |
| `get_instruction` | Полный текст по id или коду (ИП-301, ИП-403 и т.д.) |
| `semantic_search_instructions` | **Семантический поиск** (TF-IDF + cosine similarity, офлайн) |
| `list_instructions_by_topic` | Инструкции по тематическому разделу |

### Профили доступа

| Инструмент | Назначение |
|---|---|
| `suggest_access_profile` | Keyword-подбор профиля группы доступа (режим `single` / `multi`) |
| `get_roles_matrix` | Полная матрица ролей RBAC (с фильтрами) |
| `validate_roles` | Проверка корректности набора ролей |
| `get_approval_level` | Уровень согласования по набору ролей |
| `explain_profile` | **Объяснение профиля на языке бизнеса**: что делает, какие разделы, какое согласование |
| `search_by_role` | **Поиск профиля по роли 1С** (для администраторов) |
| `get_profiles_by_function` | Профили доступа, покрывающие указанную бизнес-функцию RBAC |

### Маппинг должность → профили (обезличенные данные)

| Инструмент | Назначение |
|---|---|
| `suggest_profile_by_job` | Типовые профили доступа по названию должности (417 должностей, нечёткий поиск) |
| `list_jobs` | Список всех должностей из базы данных с фильтром по подстроке |

### Новые инструменты — управление доступом (v2.1)

| Инструмент | Назначение |
|---|---|
| `get_instruction_access_requirements` | **[Идея 2]** Какие профили и роли нужны для выполнения действий из конкретной инструкции. Отвечает: «Почему сотрудник не может это сделать?» |
| `get_access_wizard` | **[Идея 1]** Интерактивный мастер подбора прав. Шаг 1: вопросы для уточнения контекста. Шаг 2: список профилей + готовый текст заявки на доступ |
| `get_user_access_journey` | **[Идея 3]** Полная цепочка «Должность → Профили → Бизнес-функции → Роли → Согласование → Инструкции». Для HR и руководителей |

---

## Примеры использования новых инструментов

### get_user_access_journey — «Что получит кладовщик в 1С?»

```
Пользователь: "Что видит кладовщик в 1С?"

Агент: get_user_access_journey(job_title="кладовщик")

Результат:
  journey_for: "Кладовщик"
  total_persons_in_db: 36
  summary:
    what_employee_will_see_in_1c: [складские документы, заявки на МПЗ, ...]
    overall_approval_level: "accounting"
    overall_approvers: ["Линейный руководитель", "Главный бухгалтер"]
  access_chain: [8 профилей с % охвата по реальным данным]
  relevant_instructions: [5 релевантных инструкций]
```

### get_access_wizard — «Оформить заявку на доступ»

```
Шаг 1 — получить вопросы:
  get_access_wizard(employee_description="новый кладовщик склад ТМЦ")
  → status: NEED_CLARIFICATION, questions: [5 уточняющих вопросов]

Шаг 2 — передать ответы:
  get_access_wizard(
    employee_description="новый кладовщик склад ТМЦ",
    answers=["Кладовщик", "Склад №3", "Нет", "Нет", "Да, приём и отпуск ТМЦ"]
  )
  → status: OK
  → recommended_profiles: [...] с объяснением что сможет делать сотрудник
  → ready_to_use_request_text: готовый текст заявки на доступ
```

### get_instruction_access_requirements — «Почему сотрудник не может создать заявку РДС?»

```
Пользователь: "Иванов не может создать заявку на расходование ДС"

Агент: get_instruction_access_requirements(instruction_id="wiki-kazn-zayavka-rds.md")

Результат:
  required_profiles: [БИТ.Исполнитель казначейства, БИТ.Казначей, ...]
  approval_level: "accounting"
  approvers_required: ["Линейный руководитель", "Главный бухгалтер"]
  if_access_denied_hint: "Используйте get_user_access_journey для проверки..."
```

---

## Установка и подключение

Сервер поддерживает два режима работы:

| Режим | Транспорт | Когда использовать |
|---|---|---|
| **stdio** (рекомендуется) | stdin/stdout | Локально в IDE — IDE сама запускает и останавливает процесс |
| **HTTP** | HTTP/SSE | Корпоративный сервер — один экземпляр для всей команды |

---

## Режим stdio — запуск через IDE (рекомендуется)

### Требования

- **Node.js 18+** — [скачать](https://nodejs.org/)

Больше ничего не нужно. IDE сама запускает сервер при открытии и останавливает при закрытии. Никаких daemon-процессов, открытых портов и ручных перезапусков.

---

### OpenCode

Добавить в `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "gti-1c": {
      "type": "local",
      "command": ["npx", "-y", "gti-1c-mcp"],
      "enabled": true
    }
  }
}
```

Готово. После сохранения файла перезапустите OpenCode.

---

### Claude Desktop

Файл конфигурации: `%APPDATA%\Claude\claude_desktop_config.json` (Windows) или `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).

```json
{
  "mcpServers": {
    "gti-1c": {
      "command": "npx",
      "args": ["-y", "gti-1c-mcp"]
    }
  }
}
```

---

### Cursor

Файл `.cursor/mcp.json` в корне проекта или `~/.cursor/mcp.json` глобально:

```json
{
  "mcpServers": {
    "gti-1c": {
      "command": "npx",
      "args": ["-y", "gti-1c-mcp"]
    }
  }
}
```

---

### Continue.dev

В файле `~/.continue/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "gti-1c",
      "command": "npx",
      "args": ["-y", "gti-1c-mcp"]
    }
  ]
}
```

---

### Передача переменных окружения (1С-подключение)

Если нужно подключить живую базу 1С, передайте переменные через `env`:

**OpenCode:**
```json
{
  "mcp": {
    "gti-1c": {
      "type": "local",
      "command": ["npx", "-y", "gti-1c-mcp"],
      "enabled": true,
      "environment": {
        "ONEC_URL": "http://ваш-сервер/база",
        "ONEC_USERNAME": "технический_пользователь",
        "ONEC_PASSWORD": "пароль"
      }
    }
  }
}
```

**Claude Desktop / Cursor:**
```json
{
  "mcpServers": {
    "gti-1c": {
      "command": "npx",
      "args": ["-y", "gti-1c-mcp"],
      "env": {
        "ONEC_URL": "http://ваш-сервер/база",
        "ONEC_USERNAME": "технический_пользователь",
        "ONEC_PASSWORD": "пароль"
      }
    }
  }
}
```

---

## Режим HTTP — корпоративный сервер

Используйте если один экземпляр сервера обслуживает несколько пользователей.

### Требования

- Node.js 18+ или Docker
- Git

### Вариант A — локальный запуск (Node.js)

```bash
git clone https://github.com/RomanSaranindev/gti-1c-mcp.git
cd gti-1c-mcp
npm install
cp .env.example .env
# Отредактировать .env — задать MCP_API_TOKEN
npm start
```

Проверить:

```bash
curl http://localhost:3031/health
```

### Вариант B — Docker

```bash
git clone https://github.com/RomanSaranindev/gti-1c-mcp.git
cd gti-1c-mcp
cp .env.example .env
# Отредактировать .env — задать MCP_API_TOKEN
docker-compose up -d
```

### Подключение клиентов к HTTP-серверу

**OpenCode:**
```json
{
  "mcp": {
    "gti-1c": {
      "type": "remote",
      "url": "http://192.168.1.100:3031/mcp",
      "headers": { "X-MCP-Token": "ВАШ_ТОКЕН" },
      "enabled": true
    }
  }
}
```

**Claude Desktop / Cursor:**
```json
{
  "mcpServers": {
    "gti-1c": {
      "url": "http://192.168.1.100:3031/mcp",
      "headers": { "X-MCP-Token": "ВАШ_ТОКЕН" }
    }
  }
}
```

Открыть порт в брандмауэре (если сервер удалённый):

```powershell
New-NetFirewallRule -DisplayName "gti-1c-mcp" -Direction Inbound -Protocol TCP -LocalPort 3031 -Action Allow
```

---

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `MCP_PORT` | `3031` | Порт HTTP-сервера |
| `MCP_API_TOKEN` | `gti-mcp-token-2024` | Токен авторизации (**смените!**) |
| `KNOWLEDGE_DIR` | `knowledge/instructions` | Путь к папке с .md-инструкциями |

---

## Структура

```
gti-1c-mcp/
├── src/
│   ├── server.js           # HTTP + MCP (12 инструментов)
│   ├── knowledge_base.js   # загрузка/поиск/выдача инструкций + fs.watch автоперезагрузка
│   ├── rbac_matrix.js      # матрица RBAC и профили доступа (122 профиля)
│   ├── job_profiles.js     # маппинг должность → профили (417 должностей, обезличенные данные)
│   └── vector_search.js    # TF-IDF + cosine similarity семантический поиск (офлайн)
├── knowledge/
│   └── instructions/       # 73 инструкции пользователя 1С.БИТ (.md)
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Безопасность

- Смените `MCP_API_TOKEN` перед публичным деплоем.
- Эндпоинты `/health` и `/` доступны без токена, все остальные — нет.
- Не публикуйте `.env` файл в репозиторий (он добавлен в `.gitignore`).
