#!/usr/bin/env python3
"""Нарезка нарисованной земли и фонов мест.

    python3 tools/build_location_art.py

Вход (assets/raw/locations/, промт — assets/raw/PROMPTS_all_sheets.md):
  terrain_sheet.png — 5×2 клеток 512: сверху бесшовная земля, снизу полоса
      верхнего слоя (трава, снег, корка) в верхней трети клетки;
  bg_<место>.png — портретный фон 1024×1792.

Выход:
  assets/terrain/<тема>/soil.png и grass.png — тайл земли и полоса верха.
      Генератор редко рисует по-настоящему бесшовно, поэтому края сводятся
      здесь: картинка смешивается со своей копией, сдвинутой на половину,
      так что на краях оказывается середина, а шов уходит под смешивание;
  assets/bg/<место>.jpg — фон, уменьшенный для телефона.
"""
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'assets/raw/locations'

# Столбец листа → темы земли (biomes.js), которые его получают
COLUMNS = [
    ('foothills', ['jungle', 'forest']),
    ('glacier', ['snow']),
    ('crater', ['hell']),
    ('space', ['urban']),
    ('windy', ['desert']),
]
CELL = 512
SOIL = 256        # тайл земли в игре
CAP_H = 44        # высота полосы верха в игре
BG_W = 1024       # ширина фона в игре (высота — по пропорции)
# Место (вид башни) → файл фона
BACKGROUNDS = {'classic': 'foothills', 'ice': 'glacier', 'lava': 'crater', 'space': 'space', 'wind': 'windy'}


def ramp(n, band):
    """0 на краях, 1 в середине: вес исходника при сведении швов."""
    i = np.arange(n)
    d = np.minimum(i, n - 1 - i)
    return np.clip(d / band, 0, 1)


def seamless(a, axes=(0, 1), band=0.22):
    """Свести противоположные края (по осям axes) массива HxWxC."""
    out = a.astype(np.float32)
    h, w = a.shape[:2]
    wy = ramp(h, h * band)[:, None] if 0 in axes else np.ones((h, 1))
    wx = ramp(w, w * band)[None, :] if 1 in axes else np.ones((1, w))
    wgt = (wy * wx)[..., None]
    shifted = out
    if 0 in axes:
        shifted = np.roll(shifted, h // 2, axis=0)
    if 1 in axes:
        shifted = np.roll(shifted, w // 2, axis=1)
    return (out * wgt + shifted * (1 - wgt)).round().clip(0, 255).astype(np.uint8)


def build_terrain():
    sheet = Image.open(RAW / 'terrain_sheet.png').convert('RGBA')
    for col, (name, themes) in enumerate(COLUMNS):
        x0 = col * CELL
        soil = sheet.crop((x0, 0, x0 + CELL, CELL)).convert('RGB')
        soil = Image.fromarray(seamless(np.asarray(soil)))
        soil = soil.resize((SOIL, SOIL), Image.LANCZOS)

        cap = sheet.crop((x0, CELL, x0 + CELL, 2 * CELL))
        a = np.asarray(cap)
        # Полоса — пока в строке есть заметная непрозрачность
        rows = (a[..., 3] > 128).mean(axis=1)
        bottom = int(np.nonzero(rows > 0.02)[0].max()) + 4
        cap = Image.fromarray(seamless(a[:bottom], axes=(1,)))
        # Почти прозрачный мусор ниже кромки — прочь
        arr = np.asarray(cap).copy()
        arr[..., 3] = np.where(arr[..., 3] < 24, 0, arr[..., 3])
        cap = Image.fromarray(arr)
        w = round(CELL * CAP_H / bottom)
        cap = cap.resize((w, CAP_H), Image.LANCZOS)

        for t in themes:
            d = ROOT / 'assets/terrain' / t
            soil.save(d / 'soil.png', optimize=True)
            cap.save(d / 'grass.png', optimize=True)
        print(f'{name}: soil {SOIL}², cap {w}x{CAP_H} (из {bottom} px) → {", ".join(themes)}')


def build_backgrounds():
    out = ROOT / 'assets/bg'
    out.mkdir(exist_ok=True)
    for place, name in BACKGROUNDS.items():
        im = Image.open(RAW / f'bg_{name}.png').convert('RGB')
        h = round(im.height * BG_W / im.width)
        im.resize((BG_W, h), Image.LANCZOS).save(out / f'{place}.jpg', quality=84, optimize=True, progressive=True)
        print(f'bg {place}: {BG_W}x{h}')


if __name__ == '__main__':
    build_terrain()
    build_backgrounds()
