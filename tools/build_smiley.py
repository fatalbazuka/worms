#!/usr/bin/env python3
"""Собрать спрайты бойца-смайлика из листа 4x4 на зелёном фоне.

    python3 tools/build_smiley.py [assets/raw/smiley/sheet.png]

На входе — картинка от генератора: 16 клеток, фон #00FF00, персонаж смотрит
вправо. На выходе — assets/smiley.png: горизонтальная лента из 16 кадров
CELL x CELL с прозрачным фоном, персонаж смотрит ВЛЕВО (так нарисованы все
спрайты движка, разворот делает он сам).

Кадры (по листу слева направо, сверху вниз):
  0-3   стоит: спокойно, моргнул, присел, вытянулся
  4-7   шаг-прыжок: присел, оттолкнулся, в воздухе, приземлился
  8     летит (рывок)      9  удивлён      10  больно      11  кружится голова
  12    целится            13 победа       14  плачет      15  призрак

Стоящие кадры выравниваются по общей линии ног, «в воздухе» сохраняют свою
высоту над ней, полёт и призрак ставятся по центру клетки: движок крутит и
двигает их вокруг центра.
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'assets/raw/smiley/sheet.png'
OUT = ROOT / 'assets/smiley.png'

GRID = 4
CELL = 100          # кадр на выходе; на экране рисуется вдвое меньше
BASE = 92           # линия ног в кадре
CENTERED = {8, 15}  # полёт и призрак — по центру клетки
AIR = {5, 6, 13}    # в воздухе: высоту над линией ног сохраняем


def key_out(im):
    """Убрать зелёный фон и зелёную кайму на сглаженных краях."""
    im = im.convert('RGBA')
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            spill = g - max(r, b)
            if spill <= 24:
                continue
            # Чем зеленее, тем прозрачнее; сам цвет — без зелёной примеси
            a = max(0, min(255, int(255 * (1 - (spill - 24) / 150))))
            px[x, y] = (r, max(r, b), b, a)
    return im


def bbox(im):
    return im.split()[3].point(lambda v: 255 if v > 40 else 0).getbbox()


def main():
    sheet = key_out(Image.open(SRC))
    step = sheet.width / GRID
    scale = CELL / step
    cells = []
    for i in range(GRID * GRID):
        cx, cy = i % GRID, i // GRID
        cell = sheet.crop((round(cx * step), round(cy * step),
                           round((cx + 1) * step), round((cy + 1) * step)))
        cell = cell.resize((CELL, CELL), Image.LANCZOS)
        cells.append((cell, bbox(cell)))

    out = Image.new('RGBA', (CELL * len(cells), CELL), (0, 0, 0, 0))
    for i, (cell, bb) in enumerate(cells):
        row = i // GRID
        # Линия ног ряда — по его стоящим кадрам
        ground = max(cells[j][1][3] for j in range(row * GRID, row * GRID + GRID)
                     if j not in AIR and j not in CENTERED)
        art = cell.crop(bb)
        x = (CELL - art.width) // 2
        if i in CENTERED:
            y = (CELL - art.height) // 2
        elif i in AIR:
            y = BASE - art.height - (ground - bb[3])
        else:
            y = BASE - art.height
        frame = Image.new('RGBA', (CELL, CELL), (0, 0, 0, 0))
        frame.paste(art, (x, max(0, y)), art)
        out.paste(frame.transpose(Image.FLIP_LEFT_RIGHT), (i * CELL, 0))
    out.save(OUT)
    print(f'{OUT.relative_to(ROOT)}: {len(cells)} кадров {CELL}x{CELL}, масштаб {scale:.3f}')


if __name__ == '__main__':
    main()
