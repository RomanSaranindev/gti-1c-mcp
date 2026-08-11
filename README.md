# gti-1c-mcp

MCP-сервер (Model Context Protocol) для **1С:БИТ / БИТ.СТРОИТЕЛЬСТВО**.

Два независимых блока:
- **База знаний инструкций** — полнотекстовый поиск и выдача 36 инструкций пользователя 1С.БИТ
- **Профили доступа RBAC** — keyword-подбор профиля группы доступа, матрица ролей, валидация, уровень согласования

Не содержит LLM-зависимостей и логики провижининга заявок — это отдельный сервис.

---

## Инструменты (7)

### База знаний

| Инструмент | Назначение |
|---|---|
| `list_instructions` | Список всех инструкций (фильтры по коду/ключевому слову) |
| `search_instructions` | Полнотекстовый поиск (scoring по TF + позиции) |
| `get_instruction` | Полный текст по id или коду (ИП-301, ИП-403 и т.д.) |

### Профили доступа

| Инструмент | Назначение |
|---|---|
| `suggest_access_profile` | Keyword-подбор профиля группы доступа (режим `single` / `multi`) |
| `get_roles_matrix` | Полная матрица ролей RBAC (с фильтрами) |
| `validate_roles` | Проверка корректности набора ролей |
| `get_approval_level` | Уровень согласования по набору ролей |

---

## Быстрый старт

```bash
# 1. Установить зависимости
npm install

# 2. Запустить (порт 3031)
npm start

# Проверить
curl http://localhost:3031/health
```

### Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `MCP_PORT` | `3031` | Порт HTTP-сервера |
| `MCP_API_TOKEN` | `gti-mcp-token-2024` | Токен авторизации (**смените!**) |
| `KNOWLEDGE_DIR` | `knowledge/instructions` | Путь к папке с .md-инструкциями |

### Docker

```bash
docker-compose up -d
```

---

## Подключение к MCP-клиенту

### Kilo Code / OpenCode

```json
{
  "mcp": {
    "gti-1c": {
      "type": "remote",
      "url": "http://localhost:3031/mcp",
      "headers": { "X-MCP-Token": "<ВАШ_ТОКЕН>" },
      "enabled": true
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "gti-1c": {
      "url": "http://localhost:3031/mcp",
      "headers": { "X-MCP-Token": "<ВАШ_ТОКЕН>" }
    }
  }
}
```

---

## Структура

```
gti-1c-mcp/
├── src/
│   ├── server.js           # HTTP + MCP (7 инструментов)
│   ├── knowledge_base.js   # загрузка/поиск/выдача инструкций
│   └── rbac_matrix.js      # матрица RBAC и профили доступа (122 профиля)
├── knowledge/
│   └── instructions/       # 36 инструкций пользователя 1С.БИТ (.md)
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Безопасность

- Смените `MCP_API_TOKEN` перед публичным деплоем.
- Эндпоинты `/health` и `/` доступны без токена, все остальные — нет.
