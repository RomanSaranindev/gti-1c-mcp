# ================================================================
# gti-1c-mcp — образ совместимый с Docker и Podman
# Base: Node.js 22 slim (Debian bookworm-slim)
# Запуск: podman build -t gti-1c-mcp .
# ================================================================
FROM node:22-slim

LABEL maintainer="ГТИ"
LABEL description="MCP-сервер: база знаний инструкций 1С.БИТ и профили доступа RBAC"
LABEL version="1.0.0"

WORKDIR /app

# Зависимости (production only — кэшируем слой)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Исходники и база знаний
COPY src/ ./src/
COPY knowledge/ ./knowledge/

# Пользователь без root-прав
# addgroup/adduser совместимы и с Debian и с Alpine
# useradd тоже есть в Debian slim — оставляем его
RUN useradd --create-home --shell /bin/sh appuser \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 3031

# Значения по умолчанию — переопределяются через env_file / -e
ENV MCP_PORT=3031
ENV MCP_API_TOKEN=gti-mcp-token-2024
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3031/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
