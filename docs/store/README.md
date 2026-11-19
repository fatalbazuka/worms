# Smiles — материалы для каталогов

Всё, что нужно для заявки в каталоги мини-приложений Telegram и для постов в каналах.

## Файлы

| Что | Где |
|---|---|
| Скриншоты 1080×1920, русский | `docs/store/ru/1.jpg` … `5.jpg` |
| Скриншоты 1080×1920, английский | `docs/store/en/1.jpg` … `5.jpg` |
| Ролик 12 с, 540 px, без звука | `assets/promo/welcome.mp4` (его же бот шлёт на /start) |

Пересобрать: поднять игру (`STATIC_DIR=. node server/index.mjs`) и
`node tools/store_shots.mjs http://127.0.0.1:3000` — скриншоты,
`node tools/record_promo.mjs http://127.0.0.1:3000` — ролик.

## Название и короткое описание

**RU.** Smiles — пошаговая артиллерия со смайликами: башня, трос, рогатка, 18 видов оружия, онлайн и турниры.

**EN.** Smiles — turn-based smiley artillery: a tower, a grappling rope, a slingshot, 18 weapons, online duels.

## Полное описание

**RU**

💥 Smiles — пошаговая артиллерия со смайликами прямо в Telegram.

🏰 Бои на высокой башне: цепляйся тросом, стреляй рогаткой, роняй врагов с этажей.
🎯 18 видов оружия: сплит-ракета, бумеранг, самонаводка, святая граната — и ящики с редкостью.
🤝 Онлайн-дуэли, турниры, таблица дня. Вызови друга из любого чата: @бот → «Вызвать на дуэль».
🎁 Задания каждый день, серия, скины и кампания с боссами.

**EN**

💥 Smiles — turn-based smiley artillery right in Telegram.

🏰 Battle on a tall tower: swing on a rope, shoot with a slingshot, knock enemies off the floors.
🎯 18 weapons: split rocket, boomerang, homing missile, holy grenade — plus crates with rarity.
🤝 Online duels, tournaments, a daily leaderboard. Challenge a friend from any chat: @bot → «Challenge to a duel».
🎁 Daily tasks, streaks, skins and a campaign with bosses.

## Подписи к скриншотам

| № | RU | EN |
|---|---|---|
| 1 | Артиллерия смайликов прямо в Telegram | Smiley artillery right in Telegram |
| 2 | Взрывай, роняй с этажей, цепляйся тросом | Blast, knock enemies off, swing on a rope |
| 3 | 18 видов оружия | 18 weapons |
| 4 | Ящики с редкостью и оружейный дождь | Crates with rarity and weapon rain |
| 5 | Делись победой в сторис и зови друзей на дуэль | Share wins in your story and challenge friends |

## Категория и теги

Игры → Стратегии / Аркады. Теги: artillery, turn-based, pvp, multiplayer, casual.

## Запускное событие

Каждую неделю сервер сам заводит бесплатный «Турнир недели» на 16 мест
(старт в субботу в 19:00 МСК) и один раз зовёт игроков, не отписавшихся от
напоминаний. Чемпиону — титул, +25 к рейтингу и 3 коробки со скинами.
Хороший повод для поста в канале: «в субботу турнир, запись в боте».
