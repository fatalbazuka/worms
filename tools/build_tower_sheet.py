"""
Нарезка листов в assets/items/ (прозрачный фон, равные клетки):
  assets/raw/tower_items_sheet.png — 4×3: оружие башни, камень, слизень,
      кактус, тролль-Великан в трёх позах;
  assets/raw/bosses_sheet.png — 4×2: йети и лавовый голем в трёх позах и
      их снаряды (снежок, огненный шар).

    python3 tools/build_tower_sheet.py

Каждая клетка обрезается по непрозрачному и уменьшается до своей высоты.
Порядок клеток — как в промте (assets/raw/PROMPTS_tower_items.md).
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'items'

# Листы: файл, столбцов, строк и по клеткам слева направо, сверху вниз —
# (имя, высота в px после уменьшения)
SHEETS = [
    ('tower_items_sheet.png', 4, 3, [
        ('shot_weight', 84), ('hand_weight', 100), ('shot_sticky', 92), ('hand_sticky', 100),
        ('shot_spring', 84), ('hand_spring', 100), ('shot_rock', 84), ('mon_slime', 84),
        ('mon_cactus', 120), ('mon_boss', 240), ('mon_boss_throw', 240), ('mon_boss_down', 200),
    ]),
    ('bosses_sheet.png', 4, 2, [
        ('mon_yeti', 240), ('mon_yeti_throw', 240), ('mon_yeti_down', 200), ('shot_snowball', 84),
        ('mon_golem', 240), ('mon_golem_throw', 240), ('mon_golem_down', 200), ('shot_fireball', 70),
    ]),
]

for file, cols, rows, cells in SHEETS:
    sheet = Image.open(ROOT / 'assets' / 'raw' / file).convert('RGBA')
    W, H = sheet.size
    cw, ch = W / cols, H / rows
    for i, (name, height) in enumerate(cells):
        c, r = i % cols, i // cols
        cell = sheet.crop((round(c * cw), round(r * ch), round((c + 1) * cw), round((r + 1) * ch)))
        # Почти прозрачную кайму не считаем: её даёт сглаживание генератора
        alpha = cell.getchannel('A').point(lambda a: 255 if a > 24 else 0)
        box = alpha.getbbox()
        if not box:
            print('пусто', name)
            continue
        pad = 3
        box = (max(0, box[0] - pad), max(0, box[1] - pad),
               min(cell.width, box[2] + pad), min(cell.height, box[3] + pad))
        img = cell.crop(box)
        k = height / img.height
        img = img.resize((max(1, round(img.width * k)), height), Image.LANCZOS)
        img.save(OUT / f'{name}.png')
        print('ok', name, img.size)
