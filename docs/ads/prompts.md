# Промты для картинок Smiles

Картинки генерируешь ты, я их потом подключаю (баннеры, плашки, каталоги).

**Что прикладывать как образец** — во всех промтах:
- лист бойца: https://fatalbazuka.ru/worms/assets/smiley.png (16 поз в ряд);
- оружие в руке: https://fatalbazuka.ru/worms/assets/items/hand_bazooka.png
  (другое оружие — там же: `hand_grenade.png`, `hand_holy.png`, `hand_boomerang.png`, `hand_homing.png`, `hand_banana.png` — мяч-попрыгунчик);
- кадр игры для стиля мира: любой из `docs/store/ru/*.jpg`.

**Общий хвост** (добавлять к каждому промту):
> Keep the characters exactly like the reference sprite sheet: glossy yellow round emoji face, big expressive cartoon eyes and mouth, tiny brown boots, white cartoon gloves, thick dark outline, sticker-like 2D cartoon style. Bright saturated colors, crisp clean 2D game illustration. No text, no letters, no logos, no UI.

Текст на картинки не просим: модели пишут кириллицу с ошибками, надписи я накладываю сам шрифтом игры.

---

## 1. Постер 9:16 — сторис, закреп, обложка ролика

> Vertical 9:16 mobile game key art. A tall tower of floating orange sandstone islands with palm trees and sunflowers, warm golden sunset sky. In the foreground a confident yellow smiley fires a chunky olive-green bazooka; the rocket with a bright smoke trail flies down to a lower island where a big cartoon explosion with flying rocks sends a light-blue rival smiley tumbling through the air with a shocked face. In the background another yellow smiley swings on a grappling rope between islands. Dynamic diagonal composition. Keep the top 30% calmer sky for a title.

## 2. Квадрат 1:1 — «Вызови друга на дуэль»

> Square 1:1 illustration. Two smileys face each other across a gap between two floating sandstone islands, like a western duel at sunset: a yellow smiley with a bazooka on the left, a light-blue smiley with a grenade on the right, both with determined squinting eyes. Between them a big glowing speech-bubble shape with two crossed cartoon rockets inside. Warm orange and purple sky, dust particles, comic tension. Leave the bottom 25% simpler for a caption.

## 3. Аватарка канала / бота 512×512

> Square 512×512 avatar icon. Close-up of one yellow smiley grinning mischievously, holding a chunky olive-green bazooka over its shoulder with a white cartoon glove, a small wisp of smoke from the barrel. Simple radial background from warm orange center to deep purple edges. The character fills 75% of the frame and stays inside a centered circle so it survives a round crop. Bold silhouette readable at 64 px.

## 4. Иконка для каталогов 512×512

> App icon, 512×512, rounded-square friendly. A yellow smiley face with a big confident grin peeks over the edge of an orange sandstone ledge, a bazooka barrel and a tiny explosion spark next to it. Flat bright purple-to-orange gradient background, very simple shapes, thick outlines, high contrast, readable at 48 px. No small details.

## 5. Турнир недели 16:9 — анонс в канале и в боте

> Wide 16:9 illustration. A festive tournament podium on top of a floating sandstone tower at golden hour: a yellow smiley with a tiny golden crown stands on the first place, raising a big golden trophy; a light-blue smiley on second place and a pink smiley on third clap. Confetti, fireworks, cartoon spotlights, small explosions in the sky like celebration. Leave the left third of the image calmer for a title.

## 6. Арсенал 16:9 — «18 видов оружия»

> Wide 16:9 illustration. A yellow smiley in the center strikes a heroic pose, surrounded by floating cartoon weapons arranged in an arc: a chunky olive bazooka, a green grenade, a glowing golden holy grenade, a wooden boomerang with red stripes, a red homing rocket with a target eye, a pink striped bouncy rubber ball, a blue magnet mine with a horseshoe magnet, a three-part split rocket. Each weapon has a soft colored glow (blue, purple, gold) like loot rarity. Dark purple background with sparkles.

## 7. Стикеры для Telegram — 8 эмоций (по одному на картинку, 512×512, прозрачный фон)

> Telegram sticker, 512×512, transparent background, single yellow smiley fighter from the reference with a thick white outline around the whole character (sticker die-cut look), centered, no background. Emotion: ___.

Эмоции по очереди: `laughing with tears, holding belly` · `shocked with a hand on cheek` · `crying a river of cartoon tears` · `smug, aiming a bazooka at the viewer` · `waving hello` · `thumbs up with a big grin` · `exploding into stars and dust, dizzy` · `sleeping in a nightcap (the light-blue rival)`.

Стикерпак — бесплатная реклама: люди шлют их в чаты, а в паке ссылка на @Fatalgame.

---

## Что делать с готовыми картинками

Скинь сюда — я положу в `docs/ads/keyart`:
- на постер 9:16 и квадрат наложу заголовок и кнопку «@Fatalgame» шрифтом игры;
- аватарку и иконку подготовлю под нужные размеры для бота и каталогов;
- из стикеров соберу пак (512×512 PNG/WebP) и напишу, как загрузить через @Stickers.
