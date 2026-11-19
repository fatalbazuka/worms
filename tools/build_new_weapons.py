#!/usr/bin/env python3
"""Нарисовать картинки нового оружия, которого нет на листах build_items.py.

    python3 tools/build_new_weapons.py

  boomerang — деревянный бумеранг (значок и снаряд)
  homing    — базука, перекрашенная в красный, с головкой наведения
  bouncer   — попрыгунчик: резиновый мяч в полоску (вместо банана)

Рисуется с четырёхкратным запасом и ужимается — края выходят гладкими.
"""
import colorsys
import math
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets/items'
SS = 4
INK = (26, 20, 16, 255)


def canvas(w, h):
    im = Image.new('RGBA', (w * SS, h * SS), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def finish(im, w, h, name):
    im = im.resize((w, h), Image.LANCZOS)
    im.save(OUT / f'{name}.png')
    print(name, im.size)


def boomerang(w, h, name):
    im, d = canvas(w, h)
    cx, cy = w * SS / 2, h * SS * 0.78
    arm = min(w, h) * SS * 0.62
    th = arm * 0.36

    def arm_poly(ang):
        dx, dy = math.cos(ang), math.sin(ang)
        nx, ny = -dy, dx
        tip = (cx + dx * arm, cy + dy * arm)
        pts = []
        for t in [i / 12 for i in range(13)]:
            r = th * (1 - t * 0.55)
            px, py = cx + dx * arm * t, cy + dy * arm * t
            pts.append((px + nx * r / 2, py + ny * r / 2))
        pts.append(tip)
        for t in [i / 12 for i in range(12, -1, -1)]:
            r = th * (1 - t * 0.55)
            px, py = cx + dx * arm * t, cy + dy * arm * t
            pts.append((px - nx * r / 2, py - ny * r / 2))
        return pts

    a1, a2 = math.radians(-140), math.radians(-40)
    for col, grow in ((INK, SS * 3), (None, 0)):
        for a in (a1, a2):
            pts = arm_poly(a)
            if grow:
                d.polygon(pts, fill=col)
                d.line(pts + [pts[0]], fill=col, width=int(grow * 2), joint='curve')
            else:
                d.polygon(pts, fill=(214, 146, 72, 255))
        if grow:
            d.ellipse([cx - th * 0.75 - grow, cy - th * 0.75 - grow, cx + th * 0.75 + grow, cy + th * 0.75 + grow], fill=col)
        else:
            d.ellipse([cx - th * 0.75, cy - th * 0.75, cx + th * 0.75, cy + th * 0.75], fill=(214, 146, 72, 255))
    # Светлая кромка и красные полоски
    for a in (a1, a2):
        dx, dy = math.cos(a), math.sin(a)
        nx, ny = -dy, dx
        d.line([(cx + nx * th * 0.2, cy + ny * th * 0.2 - th * 0.1),
                (cx + dx * arm * 0.85 + nx * th * 0.1, cy + dy * arm * 0.85 + ny * th * 0.1 - th * 0.1)],
               fill=(250, 205, 140, 255), width=SS * 3)
        for t in (0.45, 0.62):
            px, py = cx + dx * arm * t, cy + dy * arm * t
            r = th * (1 - t * 0.55) * 0.5
            d.line([(px + nx * r, py + ny * r), (px - nx * r, py - ny * r)], fill=(200, 50, 50, 255), width=SS * 3)
    finish(im, w, h, name)


def recolor(src, name, hue_to, sat=1.1, lift=1.0):
    im = Image.open(OUT / f'{src}.png').convert('RGBA')
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            # Цветные части (не перчатку и не чёрную обводку) красим
            if s > 0.28 and v > 0.2 and not (0.03 < h < 0.12 and s < 0.6):
                h = hue_to
                s = min(1, s * sat)
                v = min(1, v * lift)
            r2, g2, b2 = colorsys.hsv_to_rgb(h, s, v)
            px[x, y] = (int(r2 * 255), int(g2 * 255), int(b2 * 255), a)
    return im


def homing(src, name, eye):
    im = recolor(src, name, 0.0, 1.15)
    big = im.resize((im.width * SS, im.height * SS), Image.LANCZOS)
    d = ImageDraw.Draw(big)
    ex, ey, er = eye[0] * SS, eye[1] * SS, eye[2] * SS
    d.ellipse([ex - er - SS * 2, ey - er - SS * 2, ex + er + SS * 2, ey + er + SS * 2], fill=INK)
    d.ellipse([ex - er, ey - er, ex + er, ey + er], fill=(255, 236, 120, 255))
    d.ellipse([ex - er * 0.45, ey - er * 0.45, ex + er * 0.45, ey + er * 0.45], fill=(230, 40, 40, 255))
    finish(big, im.width, im.height, name)


def ball(w, h, name):
    im, d = canvas(w, h)
    r = min(w, h) * SS * 0.44
    cx, cy = w * SS / 2, h * SS / 2
    d.ellipse([cx - r - SS * 3, cy - r - SS * 3, cx + r + SS * 3, cy + r + SS * 3], fill=INK)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 92, 150, 255))
    # Жёлтый пояс и синие полосы
    band = Image.new('RGBA', im.size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    bd.rectangle([0, cy - r * 0.2, im.width, cy + r * 0.2], fill=(255, 214, 70, 255))
    bd.polygon([(cx - r * 0.2, 0), (cx + r * 0.15, 0), (cx - r * 0.05, im.height), (cx - r * 0.4, im.height)], fill=(80, 160, 255, 255))
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    im.paste(band, (0, 0), Image.composite(band, Image.new('RGBA', im.size), mask).split()[3])
    d = ImageDraw.Draw(im)
    d.ellipse([cx - r * 0.62, cy - r * 0.72, cx - r * 0.18, cy - r * 0.38], fill=(255, 255, 255, 200))
    finish(im, w, h, name)


boomerang(96, 80, 'hand_boomerang')
boomerang(64, 52, 'shot_boomerang')
homing('hand_bazooka', 'hand_homing', (78, 22, 7))
homing('shot_bazooka', 'shot_homing', (62, 17, 5))
ball(84, 84, 'hand_bouncer')
ball(48, 48, 'shot_bouncer')
