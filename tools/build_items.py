#!/usr/bin/env python3
"""Собрать оружие, снаряды и предметы из двух листов 4x4 на зелёном фоне.

    python3 tools/build_items.py

  assets/raw/items/hands.png — оружие в перчатке: значки арсенала и то,
                               что боец держит в руках
  assets/raw/items/shots.png — снаряды в полёте, мины, ящики, парашют, крюк

На выходе — отдельные картинки в assets/items/ с прозрачным фоном, каждая
обрезана по содержимому и вписана в квадрат SIZE (крупнее экранного размера
вдвое-втрое: движок сам ужимает, а при приближении камеры не мылится).
Порядок клеток — как в промте генератору; если лист перегенерирован с
другой раскладкой, править списки ниже.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'assets/raw/items'
OUT = ROOT / 'assets/items'
GRID = 4

# Имена совпадают с id оружия (src/weapons/index.js); fist и point — про запас
HANDS = [
    'bazooka', 'grenade', 'cluster', 'mole',
    'banana', 'holy', 'dynamite', 'mine',
    'airstrike', 'shotgun', 'bat', 'teleport',
    'mortar', 'hook', 'fist', 'point',
]
SHOTS = [
    'bazooka', 'grenade', 'cluster', 'bomblet',
    'mole', 'banana', 'holy', 'dynamite',
    'mine', 'mine_on', 'mortar', 'airmissile',
    'crate_weapon', 'crate_health', 'chute', 'hook',
]


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
            a = max(0, min(255, int(255 * (1 - (spill - 24) / 150))))
            px[x, y] = (r, max(r, b), b, a)
    return im


def cut(sheet_path, names, prefix, size):
    sheet = key_out(Image.open(sheet_path))
    step = sheet.width / GRID
    for i, name in enumerate(names):
        cx, cy = i % GRID, i // GRID
        cell = sheet.crop((round(cx * step), round(cy * step),
                           round((cx + 1) * step), round((cy + 1) * step)))
        bb = cell.split()[3].point(lambda v: 255 if v > 40 else 0).getbbox()
        art = cell.crop(bb)
        k = size / max(art.size)
        art = art.resize((max(1, round(art.width * k)), max(1, round(art.height * k))), Image.LANCZOS)
        art.save(OUT / f'{prefix}_{name}.png')
    print(f'{sheet_path.name}: {len(names)} картинок {prefix}_*.png до {size}px')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cut(RAW / 'hands.png', HANDS, 'hand', 96)
    cut(RAW / 'shots.png', SHOTS, 'shot', 72)


if __name__ == '__main__':
    main()
