# Игра — чистая статика: nginx отдаёт файлы, сборки нет.
#   docker build -t worms .
#   docker run -d -p 8080:80 -e TELEGRAM_BOT=имя_бота worms
FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
# Скрипты из /docker-entrypoint.d nginx выполняет сам перед запуском
COPY deploy/40-worms-env.sh /docker-entrypoint.d/40-worms-env.sh

WORKDIR /usr/share/nginx/html
RUN rm -rf ./*
COPY index.html env.js manifest.webmanifest ./
COPY src ./src
COPY vendor ./vendor
COPY assets ./assets
# Исходные рипы спрайтов игре не нужны (их и так режет .dockerignore)
RUN rm -rf ./assets/raw \
 && chmod +x /docker-entrypoint.d/40-worms-env.sh \
 && chown nginx:nginx ./env.js

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
