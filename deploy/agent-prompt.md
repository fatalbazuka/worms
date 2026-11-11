Задача: развернуть Telegram-игру Worms на моём сервере по адресу https://fatalbazuka.ru/worms — мини-приложение, бот, кабинет, турниры, звёзды.

Репозиторий: https://github.com/fatalbazuka/worms (ветка main)
Инструкция: DEPLOY.md — разделы «Игра по пути, а не в корне домена» и «Telegram-бот».

Данные:
- Сервер: fatalbazuka.ru, SSH — <пользователь>@fatalbazuka.ru (если root не пускает — спроси меня)
- Токен бота и мой Telegram ID я впишу в .env на сервере сам — их у тебя нет, в чат не проси.

Что сделать:
1. Зайди на сервер. Посмотри ОС, свободное место и кто держит порты 80 и 443 (`ss -ltnp`).
2. Если нет Docker с плагином compose — поставь официальным способом (docs.docker.com/engine/install).
3. Если /opt/worms уже есть — `cd /opt/worms && git pull`, иначе склонируй репозиторий туда (ветка main). Существующий .env не перезаписывай.
4. Если .env нет: `cp .env.example .env`, права 600. Впиши: HTTP_BIND=127.0.0.1, HTTP_PORT=8080, PUBLIC_URL=https://fatalbazuka.ru/worms, TELEGRAM_BOT=<имя бота без @, спроси меня>. TELEGRAM_BOT_TOKEN и ADMIN_TG_IDS оставь пустыми — впишу сам.
5. Дальше один из двух вариантов:
   а) Порты 80/443 держит nginx с сайтом fatalbazuka.ru — `docker compose up -d --build`, вставь в server { … } этого домена два блока location из deploy/nginx-subpath.conf, `nginx -t` и reload. Перед правкой покажи мне, какой файл и что меняешь.
   б) Порты свободны — допиши в .env DOMAIN=fatalbazuka.ru, WORMS_PATH=/worms, CADDYFILE=Caddyfile.subpath и `docker compose --profile https up -d --build`.
   Если порты держит что-то другое — остановись и опиши, что нашёл.
6. Проверь и пришли вывод:
   - `docker compose ps` — api и web healthy;
   - `curl -sI https://fatalbazuka.ru/worms` → редирект на /worms/; `curl -sI https://fatalbazuka.ru/worms/` → 200, сертификат валидный;
   - `curl -s https://fatalbazuka.ru/worms/api/health` → {"ok":true};
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://fatalbazuka.ru/worms/api/bot/webhook -d '{}'` → 401 (вебхук закрыт без секрета);
   - главная https://fatalbazuka.ru/ работает как раньше.
7. Скажи мне: «впиши TELEGRAM_BOT_TOKEN и ADMIN_TG_IDS в /opt/worms/.env и выполни `docker compose up -d`». После этого проверь `docker compose logs api | grep bot` — должна быть строка «[bot] @…: вебхук https://fatalbazuka.ru/worms/api/bot/webhook».
8. Настрой ежедневную копию базы через cron (раздел «Копии базы» DEPLOY.md) и запусти её один раз руками.
9. В конце пришли: что установил и поменял на сервере, как обновлять (`cd /opt/worms && git pull && docker compose up -d --build`, с `--profile https` для варианта б).

Нельзя:
- `docker compose down -v` и удаление томов — там база игроков;
- читать, печатать или пересылать токен бота;
- менять код игры, коммитить и пушить;
- открывать наружу порты 3000 и 8080;
- трогать другие сайты и сервисы на сервере без моего согласия.

Если что-то идёт не по инструкции — остановись и пришли проблему с выводом команд.
