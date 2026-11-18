# Один промт на все листы: скины, земля, фоны

Вставить целиком в генератор. Он рисует 15 картинок по очереди; присылать
их в том же порядке (или с именами из скобок) — нарежу сам:

- скины → `assets/raw/skins/<имя>.png`, режет `tools/build_smiley.py`;
- земля → режется на `soil` и `grass` для каждого места, швы делаю бесшовными кодом;
- фоны → дальний слой параллакса места.

```
I need 15 separate images for a cartoon mobile artillery game. Make them ONE BY ONE, each as its own image, in the exact order below. Never merge several into one picture, never add text, labels, watermarks or grid lines.

SHARED STYLE for every image: bright cartoon game art, thick dark brown outline (#1a1410) on characters and objects, soft cel shading, one small white highlight, flat bold colors, simple chunky shapes, consistent with round yellow smiley-face fighters.

=== PART 1. SKIN SPRITE SHEETS (images 1–9) ===
Each skin sheet: square image, 4x4 grid of equal square cells, solid pure green background (#00FF00) everywhere, no shadows on the background. The same round smiley-face character in 16 poses, side view facing RIGHT, same size and same ground line in every cell, generous padding, nothing touches cell borders, no green on the character.
Poses in order, left to right, top to bottom:
1 idle, 2 idle blinking, 3 idle crouch, 4 idle stretching up, 5 jump crouch, 6 jump push-off, 7 in the air, 8 landing, 9 flying forward fast, 10 surprised, 11 hurt with a bump on the head, 12 dizzy with stars circling, 13 aiming with a determined look, 14 victory cheer with arms up, 15 crying with tears, 16 its translucent ghost floating.

Image 1 (cool): yellow smiley wearing black sunglasses and a backwards red cap.
Image 2 (nerd): yellow smiley with big round glasses, buck teeth and a pencil behind the ear.
Image 3 (sleepy): light blue smiley in a striped blue-white nightcap with a pompom, half-closed sleepy eyes.
Image 4 (ninja): dark grey smiley in a black ninja mask with a long red headband.
Image 5 (pirate): tan smiley with a black eye patch and a pirate hat with a small skull.
Image 6 (robot): shiny silver metal robot smiley with glowing cyan LED eyes, rivets and a small antenna.
Image 7 (astro): white smiley inside a round astronaut helmet with a glass visor reflection.
Image 8 (king): golden glossy smiley with a jeweled crown and a short red cape.
Image 9 (rainbow): rainbow-gradient sparkly smiley with star-shaped highlights and tiny sparkles around.

=== PART 2. TERRAIN SHEET (image 10) ===
Image 10 (terrain): wide image 2560x1024, 5 columns x 2 rows of equal square cells, transparent background, no outlines inside the textures.
Top row — SOIL: each cell fully filled edge to edge with a seamless tileable cartoon ground texture, flat view, no perspective, low detail noise, big readable shapes.
Bottom row — TOP LAYER CAP for the same column: the cap sits in the upper third of the cell as a horizontal strip running fully from the left edge to the right edge (tileable horizontally), with a wavy lower edge hanging down a little; the rest of the cell is transparent.
Columns:
1) Foothills — soil: rich brown earth with rounded embedded pebbles and a few small roots, warm tones; cap: bright green grass with rounded tufts and tiny white and yellow flowers.
2) Glacier — soil: pale blue ice with soft lavender shading, faint cracks and frozen bubbles; cap: thick white snow with soft rounded drifts and small icicles hanging down.
3) Crater — soil: dark volcanic basalt with glowing orange lava cracks between chunky stones; cap: crust of cooled black lava with a thin glowing orange edge and small embers.
4) Space — soil: grey-purple moon rock with round craters and small embedded glowing cyan crystals; cap: lighter dusty moon soil with tiny glowing crystal shards.
5) Windy — soil: warm orange sandstone with wavy horizontal layers and small pebbles; cap: light golden sand with soft wind ripples and a few dry grass tufts.

=== PART 3. CALM BACKGROUNDS (images 11–15) ===
Each background: portrait 1024x1792, far-away scenery behind the playing field, calm and LOW CONTRAST so characters stay readable: muted desaturated colors, soft shapes, no outlines, no characters, no creatures, no buildings in the foreground, nothing important in the middle, sky in the upper two thirds with a smooth gradient, distant silhouettes only along the bottom third.
Image 11 (bg Foothills): evening sky in deep blue to warm orange, soft distant green hills and rounded pine forest silhouettes, a few faint clouds.
Image 12 (bg Glacier): cold night sky with a soft green-violet aurora, distant snowy mountain peaks and frozen pine silhouettes.
Image 13 (bg Crater): dark smoky red-brown sky with a faint orange glow near the bottom, distant volcano silhouettes with thin smoke columns.
Image 14 (bg Space): deep purple-blue starfield with a soft nebula, a big faint ringed planet and a small moon, distant rocky asteroid silhouettes at the bottom.
Image 15 (bg Windy): dusty pale yellow-orange sky with long horizontal wind streaks, distant sandstone mesas and a few dry tree silhouettes.
```
