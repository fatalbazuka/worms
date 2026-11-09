# Сервер аккаунтов и рейтинга: Node без зависимостей, база SQLite в томе.
# Собирается из корня репозитория:
#   docker build -f server/Dockerfile -t worms-api .
FROM node:22-alpine

WORKDIR /app
COPY server ./server

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/worms.db \
    TRUST_PROXY=1 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
