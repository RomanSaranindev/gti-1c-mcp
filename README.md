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

## Установка на новом рабочем месте

### Требования

- Node.js 18+ ([скачать](https://nodejs.org/))
- Git
- (опционально) Docker + Docker Compose

---

### Вариант 1 — локальный запуск (Node.js)

#### Шаг 1. Клонировать репозиторий

```bash
# С GitHub:
git clone https://github.com/RomanSaranindev/gti-1c-mcp.git

# Или с GitLab (внутренний):
git clone https://gitlab.ide-spb.com/saraninrg/gti-1c-mcp.git

cd gti-1c-mcp
```

#### Шаг 2. Установить зависимости

```bash
npm install
```

#### Шаг 3. Настроить окружение

```bash
# Скопировать шаблон
cp .env.example .env
```

Открыть `.env` и задать токен:

```env
MCP_PORT=3031
MCP_API_TOKEN=ВАШ_СЕКРЕТНЫЙ_ТОКЕН
```

> Токен по умолчанию `gti-mcp-token-2024` — обязательно смените перед деплоем.

#### Шаг 4. Запустить сервер

```bash
npm start
```

Проверить:

```bash
curl http://localhost:3031/health
```

---

### Вариант 2 — Docker

```bash
git clone https://github.com/RomanSaranindev/gti-1c-mcp.git
cd gti-1c-mcp

cp .env.example .env
# Отредактировать .env — задать MCP_API_TOKEN

docker-compose up -d
```

Проверить:

```bash
curl http://localhost:3031/health
```

---

### Вариант 3 — автозапуск на Windows (Task Scheduler)

Чтобы сервер стартовал при загрузке Windows без ручного запуска:

1. Открыть **Планировщик заданий** (`taskschd.msc`)
2. Действие → Создать задачу
3. Вкладка **Общие**: имя `gti-1c-mcp`, выполнять для всех пользователей
4. Вкладка **Триггеры**: При запуске системы
5. Вкладка **Действия** → Создать:
   - Программа: `node`
   - Аргументы: `src/server.js`
   - Рабочая папка: полный путь к папке проекта (например `C:\projects\gti-1c-mcp`)
6. Вкладка **Условия**: снять галку "Только при питании от сети"
7. ОК → ввести пароль пользователя Windows

Или через PowerShell (запустить от администратора):

```powershell
$action = New-ScheduledTaskAction `
    -Execute "node" `
    -Argument "src/server.js" `
    -WorkingDirectory "C:\projects\gti-1c-mcp"

$trigger = New-ScheduledTaskTrigger -AtStartup

Register-ScheduledTask `
    -TaskName "gti-1c-mcp" `
    -Action $action `
    -Trigger $trigger `
    -RunLevel Highest `
    -Force
```

---

## Подключение к MCP-клиенту

### OpenCode / Kilo Code

Добавить в `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "gti-1c": {
      "type": "remote",
      "url": "http://localhost:3031/mcp",
      "headers": { "X-MCP-Token": "ВАШ_ТОКЕН" },
      "enabled": true
    }
  }
}
```

После сохранения — перезапустить opencode.

---

### Claude Desktop

В файл конфигурации Claude Desktop:

```json
{
  "mcpServers": {
    "gti-1c": {
      "url": "http://localhost:3031/mcp",
      "headers": { "X-MCP-Token": "ВАШ_ТОКЕН" }
    }
  }
}
```

---

### Если сервер на другой машине в сети

Замените `localhost` на IP или hostname сервера:

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

Убедитесь, что порт `3031` открыт в брандмауэре сервера:

```powershell
# На сервере (PowerShell, от администратора):
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
