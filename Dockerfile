# ================================================================
# gti-1c-mcp — Docker образ
# Base: Node.js 22 slim
# ================================================================
FROM node:22-slim

LABEL maintainer="ГТИ"
LABEL description="MCP-сервер: база знаний инструкций 1С.БИТ и профили доступа RBAC"
LABEL version="1.0.0"

WORKDIR /app

# Зависимости (production only — кэшируем слой)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Исходники и база знаний
COPY src/ ./src/
COPY knowledge/ ./knowledge/

# Пользователь без root-прав
RUN useradd --create-home appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 3031

ENV MCP_PORT=3031
ENV MCP_API_TOKEN=gti-mcp-token-2024
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3031/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
