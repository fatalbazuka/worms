"""
Картинки оружия башни, нарисованные кодом: гиря, липкая бомба, батут.

Временные: в стиле остальных предметов (толстый тёмный контур, мягкая
заливка, блик), пока не нарисованы настоящие листом через генератор.
Как появятся — положить поверх в assets/items/ с теми же именами.

    python3 tools/draw_tower_items.py

hand_<id> — в перчатке (значок арсенала и в руках бойца),
shot_<id> — в полёте или на земле.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'assets' / 'items'
SS = 4                      # рисуем крупнее и уменьшаем — сглаживание
INK = (26, 20, 16, 255)


def canvas(w, h):
    return Image.new('RGBA', (w * SS, h * SS), (0, 0, 0, 0))


def done(img, name):
    w, h = img.size
    img.resize((w // SS, h // SS), Image.LANCZOS).save(OUT / f'{name}.png')
    print('ok', name)


def s(*v):
    return [round(x * SS) for x in v]


def ellipse(d, box, fill, width=4):
    d.ellipse(s(*box), fill=fill, outline=INK, width=width * SS)


def rrect(d, box, r, fill, width=4):
    d.rounded_rectangle(s(*box), radius=r * SS, fill=fill, outline=INK, width=width * SS)


def glove(d, cx, cy, size=1.0):
    """Белая перчатка снизу-слева — как у остальных hand_*."""
    k = size
    ellipse(d, (cx - 20 * k, cy - 12 * k, cx + 16 * k, cy + 16 * k), (250, 250, 250, 255), 3)
    for i in range(3):
        y = cy - 10 * k + i * 8 * k
        ellipse(d, (cx + 6 * k, y, cx + 26 * k, y + 10 * k), (250, 250, 250, 255), 3)


# --- гиря ---------------------------------------------------------------

def weight(d, ox, oy, k=1.0):
    # Дужка
    d.arc(s(ox + 14 * k, oy + 0 * k, ox + 58 * k, oy + 44 * k), 180, 360, fill=INK, width=round(16 * k * SS))
    d.arc(s(ox + 17 * k, oy + 3 * k, ox + 55 * k, oy + 41 * k), 180, 360, fill=(110, 116, 130, 255), width=round(9 * k * SS))
    # Тело
    ellipse(d, (ox + 4 * k, oy + 18 * k, ox + 68 * k, oy + 80 * k), (64, 68, 78, 255), 4)
    ellipse(d, (ox + 14 * k, oy + 28 * k, ox + 30 * k, oy + 42 * k), (150, 156, 170, 255), 0)
    # Табличка «16»
    rrect(d, (ox + 22 * k, oy + 48 * k, ox + 50 * k, oy + 64 * k), 4 * k, (255, 214, 92, 255), 3)


img = canvas(72, 84)
weight(ImageDraw.Draw(img), 0, 2)
done(img, 'shot_weight')

img = canvas(90, 96)
d = ImageDraw.Draw(img)
weight(d, 14, 0, 1.0)
glove(d, 24, 78, 0.9)
done(img, 'hand_weight')


# --- липкая бомба ---------------------------------------------------------

def sticky(d, ox, oy, k=1.0):
    green = (126, 214, 80, 255)
    ellipse(d, (ox + 2 * k, oy + 12 * k, ox + 66 * k, oy + 72 * k), green, 4)
    # Капли слизи свисают снизу
    for x, ln in ((16, 10), (32, 16), (48, 8)):
        rrect(d, (ox + x * k, oy + 60 * k, ox + (x + 10) * k, oy + (66 + ln) * k), 5 * k, green, 3)
    ellipse(d, (ox + 4 * k, oy + 14 * k, ox + 64 * k, oy + 66 * k), green, 0)
    ellipse(d, (ox + 14 * k, oy + 22 * k, ox + 28 * k, oy + 34 * k), (220, 255, 190, 255), 0)
    # Фитиль
    d.line(s(ox + 40 * k, oy + 14 * k, ox + 50 * k, oy + 2 * k), fill=INK, width=round(6 * k * SS))
    ellipse(d, (ox + 46 * k, oy - 2 * k, ox + 56 * k, oy + 8 * k), (255, 140, 60, 255), 2)


img = canvas(70, 90)
sticky(ImageDraw.Draw(img), 1, 4)
done(img, 'shot_sticky')

img = canvas(90, 100)
d = ImageDraw.Draw(img)
sticky(d, 18, 6)
glove(d, 22, 78, 0.9)
done(img, 'hand_sticky')


# --- батут ----------------------------------------------------------------

def spring(d, ox, oy, k=1.0):
    # Основание
    rrect(d, (ox + 4 * k, oy + 50 * k, ox + 76 * k, oy + 62 * k), 5 * k, (70, 74, 84, 255), 4)
    # Пружина зигзагом
    pts = []
    for i in range(7):
        x = ox + (22 if i % 2 else 58) * k
        y = oy + (48 - i * 6) * k
        pts += [x, y]
    d.line([round(v * SS) for v in pts], fill=INK, width=round(9 * k * SS), joint='curve')
    d.line([round(v * SS) for v in pts], fill=(200, 206, 220, 255), width=round(4 * k * SS), joint='curve')
    # Площадка
    rrect(d, (ox + 2 * k, oy + 4 * k, ox + 78 * k, oy + 16 * k), 6 * k, (236, 72, 72, 255), 4)
    rrect(d, (ox + 10 * k, oy + 6 * k, ox + 40 * k, oy + 9 * k), 2 * k, (255, 170, 170, 255), 0)


img = canvas(80, 66)
spring(ImageDraw.Draw(img), 0, 2)
done(img, 'shot_spring')

img = canvas(96, 90)
d = ImageDraw.Draw(img)
spring(d, 14, 10)
glove(d, 22, 72, 0.9)
done(img, 'hand_spring')


# --- монстры --------------------------------------------------------------

def eyes(d, cx, cy, k=1.0, angry=False):
    for dx in (-9, 9):
        ellipse(d, (cx + dx * k - 6 * k, cy - 7 * k, cx + dx * k + 6 * k, cy + 7 * k), (255, 255, 255, 255), 3)
        ellipse(d, (cx + dx * k - 2 * k, cy - 2 * k, cx + dx * k + 3 * k, cy + 4 * k), INK, 0)
    if angry:
        d.line(s(cx - 16 * k, cy - 12 * k, cx - 4 * k, cy - 7 * k), fill=INK, width=round(4 * k * SS))
        d.line(s(cx + 16 * k, cy - 12 * k, cx + 4 * k, cy - 7 * k), fill=INK, width=round(4 * k * SS))


# Слизень: зелёная капля с глазами
img = canvas(80, 64)
d = ImageDraw.Draw(img)
d.polygon(s(6, 60, 74, 60, 70, 40, 56, 14, 40, 6, 24, 14, 10, 40), fill=INK)
d.polygon(s(11, 56, 69, 56, 65, 40, 53, 18, 40, 11, 27, 18, 15, 40), fill=(140, 220, 70, 255))
ellipse(d, (20, 20, 32, 30), (220, 255, 190, 255), 0)
eyes(d, 40, 36, 1.0, angry=True)
done(img, 'mon_slime')

# Кактус-мина: в горшке-бочонке, с иголками и злыми глазами
img = canvas(64, 92)
d = ImageDraw.Draw(img)
green = (76, 175, 80, 255)
rrect(d, (6, 26, 20, 56), 7, green, 4)          # левая рука
rrect(d, (44, 18, 58, 48), 7, green, 4)          # правая рука
rrect(d, (16, 4, 48, 80), 16, green, 4)          # ствол
for x, y in ((20, 20), (44, 30), (18, 50), (46, 60), (32, 12), (10, 34), (54, 26)):
    d.line(s(x, y, x + (4 if x > 32 else -4), y - 4), fill=INK, width=2 * SS)
eyes(d, 32, 34, 0.9, angry=True)
rrect(d, (10, 70, 54, 90), 5, (205, 110, 60, 255), 4)   # горшок
done(img, 'mon_cactus')
