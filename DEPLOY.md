# Развёртывание на своём сервере

Из чего состоит:

| Часть  | Что это                                              | Где живёт                    |
|--------|------------------------------------------------------|------------------------------|
| `web`  | nginx: раздаёт игру, проксирует `/api` в `api`       | контейнер, без состояния     |
| `api`  | аккаунты и рейтинг: Node 22 + SQLite, без зависимостей | контейнер, база в томе `worms_data` |
| `caddy`| HTTPS: сам получает и продлевает сертификат          | контейнер, сертификаты в томе `caddy_data` |

Сетевые ходы идут через Supabase Realtime (облако, уже прописано в коде),
серверу для этого ничего не нужно.

HTTPS обязателен: Telegram Mini App открывается только по HTTPS, а
браузеры без него не дают части возможностей.

## Что нужно

* Linux-сервер с Docker и плагином compose (`docker compose version`);
* открытые порты 80 и 443;
* домен с A-записью на IP сервера.

## Настройки — файл `.env`

Образец — `.env.example`.

| Переменная            | Что это                                                        |
|-----------------------|----------------------------------------------------------------|
| `DOMAIN`              | домен для HTTPS, например `worms.example.com`                  |
| `HTTP_BIND`, `HTTP_PORT` | где слушает контейнер игры; с Caddy — `127.0.0.1` и `8080`  |
| `TELEGRAM_BOT_TOKEN`  | **секрет**, токен бота от @BotFather: игроки из Telegram входят в аккаунт сами. Уходит только в контейнер `api`. Пусто — вход только по нику и паролю |
| `TELEGRAM_BOT`        | имя бота без `@` — для ссылок-приглашений `t.me/бот?startapp=`  |
| `TELEGRAM_APP`        | короткое имя Mini App, если он заведён через `/newapp`         |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | свой проект Supabase для сетевой игры; пусто — прописанный в коде |
| `WORMS_UI`            | `desktop` или `touch` — навязать интерфейс; пусто — по устройству |
| `WORMS_API`           | адрес API для браузера; пусто — `/api` на этом же домене       |

Всё, кроме `TELEGRAM_BOT_TOKEN`, попадает в `env.js`, который видит любой
игрок, — секретов туда не класть. `env.js` пишется при каждом старте
контейнера: поменял `.env` — `docker compose up -d`.

## Установка (Docker + автоматический HTTPS)

```bash
git clone https://github.com/fatalbazuka/worms.git
cd worms
cp .env.example .env
nano .env     # DOMAIN=…, HTTP_BIND=127.0.0.1, по желанию TELEGRAM_BOT и TELEGRAM_BOT_TOKEN
docker compose --profile https up -d --build
```

Проверка:

```bash
docker compose --profile https ps          # api, web — healthy; caddy — Up
curl https://$DOMAIN/api/health            # {"ok":true}
curl -I https://$DOMAIN/                   # 200, text/html
```

Открыть `https://ДОМЕН/` → «Аккаунт» → ник и пароль → «Создать аккаунт».

## Если на сервере уже есть nginx или Traefik

Caddy не нужен: `HTTP_BIND=127.0.0.1`, `HTTP_PORT=8080`, и

```bash
docker compose up -d --build        # без --profile https
```

В своём nginx:

```nginx
server {
    server_name worms.example.com;
    # … listen 443 ssl и сертификаты …
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`/api` контейнер `web` проксирует сам.

## Игра по пути, а не в корне домена (https://домен/worms)

Игра сама работает в любой папке сайта: все её адреса относительные, API —
`api/` рядом со страницей. Нужно только, чтобы веб-сервер отдавал её по
этому пути и срезал префикс.

**На сервере уже есть nginx с сайтом** — поднять игру без Caddy и вставить
в `server { … }` нужного домена два блока из `deploy/nginx-subpath.conf`:

```bash
# .env: HTTP_BIND=127.0.0.1, HTTP_PORT=8080
docker compose up -d --build
sudo nano /etc/nginx/sites-available/<сайт>   # вставить блоки location
sudo nginx -t && sudo systemctl reload nginx
```

**Своего веб-сервера нет** — Caddy с отдельным конфигом:

```bash
# .env: DOMAIN=…, HTTP_BIND=127.0.0.1, WORMS_PATH=/worms, CADDYFILE=Caddyfile.subpath
docker compose --profile https up -d --build
```

Адрес без слэша (`/worms`) перенаправляется на `/worms/`: иначе браузер
считал бы относительные адреса от корня.

## Без Docker

Нужен Node 22.13+ и nginx.

```bash
sudo useradd --system --home /opt/worms worms
sudo git clone https://github.com/fatalbazuka/worms.git /opt/worms
sudo mkdir -p /var/lib/worms && sudo chown worms: /var/lib/worms
sudo cp /opt/worms/deploy/worms-api.service /etc/systemd/system/
sudo systemctl enable --now worms-api          # API на 127.0.0.1:3000

cd /opt/worms && sudo npm run build            # игра → dist/
sudo rsync -a --delete dist/ /var/www/worms/
sudo cp deploy/nginx-site.conf /etc/nginx/sites-available/worms   # поправить server_name
sudo ln -s ../sites-available/worms /etc/nginx/sites-enabled/
sudo certbot --nginx -d worms.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Токен бота — строкой `Environment=TELEGRAM_BOT_TOKEN=…` в юните (или
`EnvironmentFile=`).

## Копии базы

База — один файл SQLite в томе `worms_data`. Снимок на ходу, без остановки:

```bash
docker compose exec api node server/backup.mjs
# → /data/backups/worms-<время>.db, хранятся последние 14
```

Раз в сутки по cron (`crontab -e`):

```
17 4 * * * cd /путь/к/worms && docker compose exec -T api node server/backup.mjs >/dev/null
```

Забрать копию с сервера:
`docker compose cp api:/data/backups ./backups`.

Восстановить из копии (`./backups/worms-…db` на сервере):

```bash
docker compose stop api
docker compose run --rm --no-deps -v "$PWD/backups:/restore:ro" api \
  node server/restore.mjs /restore/worms-<время>.db
docker compose start api
```

Скрипт сначала проверяет копию и только потом ставит её на место; прежняя
база не удаляется, а переименовывается в `worms.db.before-restore-<время>`.

## Обновление

```bash
git pull
docker compose --profile https up -d --build
```

База и сертификаты в томах — при обновлении не трогаются. Схема базы
обновляется сама при старте `api` (миграции в `server/db.mjs`). Код игры
отдаётся с перепроверкой, игроки получат новую версию при следующем
открытии страницы.

**Не делать** `docker compose down -v` — `-v` удаляет тома вместе с базой.

## Telegram

Если игра живёт и как Mini App: @BotFather → Bot Settings → Configure
Mini App → `https://ДОМЕН/`; имя бота — в `TELEGRAM_BOT`, токен — в
`TELEGRAM_BOT_TOKEN`. Тогда игрок из Telegram сразу в аккаунте под своим
именем, без пароля.

## Что внутри

* `web` — `nginx:1.27-alpine`, конфиг `deploy/nginx.conf`: gzip, кэш по
  типу файлов, CSP `frame-ancestors` (встраивание только в Telegram),
  `nosniff`, скрытые файлы не отдаются, `/healthz`. Внутри только файлы
  для браузера, около 2,5 МБ.
* `api` — `node:22-alpine`, работает от пользователя `node`, порт наружу
  не открыт. Пароли — scrypt, токены в базе — только хэшами, ограничитель
  перебора паролей и массовой регистрации. `/api/health` — проверка
  живости.
* `caddy` — `caddy:2-alpine`, конфиг `deploy/Caddyfile`.
