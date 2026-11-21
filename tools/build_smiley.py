#!/usr/bin/env python3
"""Собрать спрайты бойца-смайлика из листа 4x4 на зелёном фоне.

    python3 tools/build_smiley.py            # основной смайлик и все скины
    python3 tools/build_smiley.py лист.png выход.png

Скины — листы той же раскладки в assets/raw/skins/<имя>.png; на выходе
assets/skin_<имя>.png. Список скинов для игры — src/core/skins.js.

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
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets/raw/smiley/sheet.png'
OUT = ROOT / 'assets/smiley.png'
SKINS = ROOT / 'assets/raw/skins'

GRID = 4
CELL = 100          # кадр на выходе; на экране рисуется вдвое меньше
BASE = 92           # линия ног в кадре
CENTERED = {8, 15}  # полёт и призрак — по центру клетки
AIR = {5, 6, 13}    # в воздухе: высоту над линией ног сохраняем


def key_out(im):
    """Убрать зелёный фон и зелёную кайму на сглаженных краях.

    Фон — чистый яркий зелёный; персонаж тоже бывает зеленоватым (токсик в
    пятнах), поэтому «всё зелёное прозрачно» не годится. Фоном считается
    только насыщенный зелёный, а смягчение каймы применяется лишь в двух
    пикселях от него — пятна внутри персонажа остаются как есть.
    """
    im = im.convert('RGBA')
    w, h = im.size
    data = list(im.getdata())
    bg = Image.new('L', (w, h))
    bg.putdata([255 if (g > 170 and r < 120 and b < 120 and g - max(r, b) > 90) else 0
                for (r, g, b, _) in data])
    near = list(bg.filter(ImageFilter.MaxFilter(5)).getdata())
    out = []
    for (r, g, b, _), is_bg, edge in zip(data, bg.getdata(), near):
        if is_bg:
            out.append((r, max(r, b), b, 0))
            continue
        spill = g - max(r, b)
        if edge and spill > 24:
            a = max(0, min(255, int(255 * (1 - (spill - 24) / 150))))
            out.append((r, max(r, b), b, a))
        else:
            out.append((r, g, b, 255))
    im.putdata(out)
    return im


def bbox(im):
    return im.split()[3].point(lambda v: 255 if v > 40 else 0).getbbox()


def build(src, out_path):
    sheet = key_out(Image.open(src))
    step = sheet.width / GRID
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
    # Палитра на 256 цветов без дизеринга: глазом не отличить, а файл в
    # пять раз легче — 25 скинов грузятся при запуске, на мобильном
    # интернете тяжёлые листы обрывались и бойцы становились заглушками
    out = out.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    out.save(out_path, optimize=True)
    print(f'{Path(out_path).name}: {len(cells)} кадров {CELL}x{CELL}')


def main():
    if len(sys.argv) > 2:
        build(Path(sys.argv[1]), Path(sys.argv[2]))
        return
    build(SRC, OUT)
    for src in sorted(SKINS.glob('*.png')):
        build(src, ROOT / f'assets/skin_{src.stem}.png')


if __name__ == '__main__':
    main()
