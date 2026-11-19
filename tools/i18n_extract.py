#!/usr/bin/env python3
"""Собрать русские строки из src/ — заготовка для словаря src/i18n/en.js.

    python3 tools/i18n_extract.py            # список в tools/i18n_strings.json
    python3 tools/i18n_extract.py --missing  # каких строк ещё нет в словаре

Шаблоны `…${x}…` записываются с местами {0}, {1}…: так же их ищет
src/i18n/index.js, когда текст на экране собран из кусков.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CYR = re.compile(r'[А-Яа-яЁё]')
SKIP_LINE = re.compile(r'^\s*(//|\*|/\*)|console\.(log|warn|error|info)')


def literals(text):
    """Строковые литералы JS: '…', "…", `…` (с ${…} внутри)."""
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '/' and i + 1 < n and text[i + 1] == '/':
            i = text.find('\n', i)
            if i < 0:
                return
            continue
        if c == '/' and i + 1 < n and text[i + 1] == '*':
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in '\'"':
            j = i + 1
            buf = []
            while j < n and text[j] != c:
                if text[j] == '\\' and j + 1 < n:
                    buf.append(text[j:j + 2])
                    j += 2
                    continue
                if text[j] == '\n':
                    break
                buf.append(text[j])
                j += 1
            yield i, ''.join(buf)
            i = j + 1
            continue
        if c == '`':
            j = i + 1
            buf = []
            k = 0
            while j < n and text[j] != '`':
                if text[j] == '\\' and j + 1 < n:
                    buf.append(text[j:j + 2])
                    j += 2
                    continue
                if text[j] == '$' and j + 1 < n and text[j + 1] == '{':
                    depth = 1
                    j += 2
                    while j < n and depth:
                        if text[j] == '{':
                            depth += 1
                        elif text[j] == '}':
                            depth -= 1
                        elif text[j] in '\'"`':
                            # строки внутри выражения тоже бывают русскими
                            q = text[j]
                            s = j + 1
                            while s < n and text[s] != q:
                                s += 2 if text[s] == '\\' else 1
                            inner = text[j + 1:s]
                            if CYR.search(inner) and q != '`':
                                yield j, inner
                            j = s
                        j += 1
                    buf.append('{%d}' % k)
                    k += 1
                    continue
                buf.append(text[j])
                j += 1
            yield i, ''.join(buf)
            i = j + 1
            continue
        i += 1


def unescape(s):
    return s.replace("\\'", "'").replace('\\"', '"').replace('\\n', '\n').replace('\\`', '`').replace('\\\\', '\\')


def collect():
    found = {}
    for root, _, files in os.walk(os.path.join(ROOT, 'src')):
        if 'i18n' in root:
            continue
        for f in sorted(files):
            if not f.endswith('.js'):
                continue
            path = os.path.join(root, f)
            text = open(path, encoding='utf8').read()
            lines = text.split('\n')
            offsets = [0]
            for ln in lines:
                offsets.append(offsets[-1] + len(ln) + 1)
            import bisect
            for pos, s in literals(text):
                if not CYR.search(s):
                    continue
                line = lines[bisect.bisect_right(offsets, pos) - 1]
                if SKIP_LINE.search(line):
                    continue
                s = unescape(s)
                found.setdefault(s, os.path.relpath(path, ROOT))
    for extra in ('index.html',):
        text = open(os.path.join(ROOT, extra), encoding='utf8').read()
        for m in re.finditer(r'>([^<>]*[А-Яа-яЁё][^<>]*)<', text):
            s = ' '.join(m.group(1).split())
            if s:
                found.setdefault(s, extra)
        for m in re.finditer(r'(?:placeholder|title|aria-label)="([^"]*[А-Яа-яЁё][^"]*)"', text):
            found.setdefault(m.group(1), extra)
    return found


def main():
    found = collect()
    if '--missing' in sys.argv:
        en = open(os.path.join(ROOT, 'src/i18n/en.js'), encoding='utf8').read()
        have = set(json.loads(en[en.index('EN = ') + 5:en.rindex('}') + 1]).keys())
        miss = {k: v for k, v in found.items() if k not in have}
        print(json.dumps(miss, ensure_ascii=False, indent=1))
        print(len(miss), 'нет в словаре', file=sys.stderr)
        return
    out = os.path.join(ROOT, 'tools/i18n_strings.json')
    json.dump(found, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print(len(found), 'строк →', out)


if __name__ == '__main__':
    main()
