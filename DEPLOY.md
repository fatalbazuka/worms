# Развёртывание на своём сервере

Игра — чистая статика: HTML, JS-модули, картинки. Сборщика кода нет,
базы на сервере нет. Сетевая игра идёт через Supabase Realtime (облако),
рейтинг — через Edge Function в том же Supabase. Твоему серверу нужно
только отдавать файлы по HTTPS.

Ниже три способа, от простого к ручному. Для всех нужен домен, который
смотрит на сервер (A-запись), если нужен HTTPS, — а он нужен: Telegram
Mini App открывается только по HTTPS, и без него браузеры не дают части
возможностей (полный экран на некоторых устройствах, буфер обмена для
ссылки-приглашения).

## Что нужно на сервере

* Linux с Docker и плагином compose (`docker compose version`);
* открытые порты 80 и 443 (для способа 1);
* домен, указывающий на сервер.

## Настройки

Всё задаётся переменными в `.env` (образец — `.env.example`):

| Переменная            | Что это                                                        |
|-----------------------|----------------------------------------------------------------|
| `DOMAIN`              | домен для HTTPS, например `worms.example.com`                  |
| `HTTP_BIND`, `HTTP_PORT` | где слушает контейнер игры (по умолчанию `0.0.0.0:8080`)    |
| `SUPABASE_URL`        | адрес проекта Supabase для сетевой игры                        |
| `SUPABASE_ANON_KEY`   | publishable/anon-ключ того же проекта                          |
| `SUPABASE_LEGACY_KEY` | старый anon-ключ (JWT) — запасной, можно не задавать           |
| `TELEGRAM_BOT`        | имя бота без `@` — для ссылок-приглашений `t.me/бот?startapp=` |
| `TELEGRAM_APP`        | короткое имя Mini App, если он заведён через `/newapp`         |
| `WORMS_UI`            | `desktop` или `touch` — навязать интерфейс всем; пусто — по устройству |

Пустая переменная — значение по умолчанию из кода (`src/net/supabase.js`,
`src/platform/telegram.js`). Значения попадают в `env.js`, который
отдаётся браузеру, поэтому **ключ `service_role` сюда класть нельзя** —
только публичный anon/publishable.

`env.js` пишется заново при каждом старте контейнера: поменял `.env` —
`docker compose up -d`, пересобирать образ не нужно.

## Способ 1. Docker + автоматический HTTPS (рекомендую)

```bash
git clone https://github.com/fatalbazuka/worms.git
cd worms
cp .env.example .env
nano .env          # DOMAIN=…, HTTP_BIND=127.0.0.1, при желании TELEGRAM_BOT=…
docker compose --profile https up -d --build
```

Поднимутся два контейнера: `web` (nginx с игрой) и `caddy` (обратный
прокси). Caddy сам получит сертификат Let's Encrypt для `DOMAIN` и будет
его продлевать; сертификаты лежат в томе `caddy_data` и переживают
перезапуски. `HTTP_BIND=127.0.0.1` прячет порт 8080 от внешнего мира —
игра доступна только через Caddy.

Проверка:

```bash
docker compose ps                     # оба Up, web — healthy
curl -I https://$DOMAIN/              # 200, text/html
curl https://$DOMAIN/env.js           # твои настройки
```

## Способ 2. Docker за уже работающим nginx/Traefik

Если на сервере уже есть обратный прокси с сертификатами:

```bash
cp .env.example .env    # HTTP_BIND=127.0.0.1, HTTP_PORT=8080
docker compose up -d --build
```

И в существующем nginx:

```nginx
server {
    server_name worms.example.com;
    # … твои listen 443 ssl и сертификаты …
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Без compose то же самое одной командой:

```bash
docker build -t worms .
docker run -d --name worms --restart unless-stopped \
  -p 127.0.0.1:8080:80 -e TELEGRAM_BOT=имя_бота worms
```

## Способ 3. Без Docker: nginx на самом сервере

```bash
npm run build                        # на своей машине; Node 18+
rsync -a --delete dist/ user@server:/var/www/worms/
```

Переменные из таблицы выше можно передать сборке:
`TELEGRAM_BOT=имя_бота npm run build`. Пример сайта для nginx —
`deploy/nginx-site.conf`: в нём правильные типы файлов, кэш (код — с
перепроверкой, Phaser — навсегда) и `frame-ancestors` для Telegram.
Сертификат — `certbot --nginx -d worms.example.com`.

## Обновление

```bash
git pull
docker compose --profile https up -d --build    # или без --profile, если без Caddy
```

Код игры отдаётся с `must-revalidate`, поэтому игроки получат новую версию
при следующем открытии страницы, без «очистите кэш».

## Telegram

Если игра должна жить и как Mini App: в `@BotFather` → Bot Settings →
Configure Mini App → указать `https://ДОМЕН/`, и вписать имя бота в
`TELEGRAM_BOT`. Подробнее — раздел «Деплой» в README.

SDK Telegram грузится только когда страница открыта внутри Telegram; в
обычном браузере его нет вовсе, и игра идёт как обычный сайт.

## Supabase

Сетевая игра использует только Broadcast-каналы Realtime — таблиц не
читает и не пишет. Если хочешь свой проект вместо прописанного в коде:
создай его на supabase.com, возьми из Settings → API адрес и
publishable-ключ и впиши в `SUPABASE_URL` / `SUPABASE_ANON_KEY`. Для
рейтинга дополнительно нужны таблицы из `docs/rating.sql` и функция
`supabase/functions/worms-result` (`supabase functions deploy worms-result`).

Без Supabase игра работает: быстрая игра и кампания — полностью, онлайн —
нет.

## Что внутри образа

* `nginx:1.27-alpine`, конфиг — `deploy/nginx.conf`;
* только файлы для браузера: `index.html`, `env.js`, `manifest.webmanifest`,
  `src/`, `vendor/`, `assets/` без исходных рипов — около 2,5 МБ;
* `deploy/40-worms-env.sh` пишет `env.js` при старте;
* `/healthz` — проверка живости для Docker и мониторинга;
* gzip, заголовки `Cache-Control` по типу файлов, CSP `frame-ancestors`
  (встраивание только в Telegram), `nosniff`; скрытые файлы не отдаются.
