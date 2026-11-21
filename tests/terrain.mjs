/**
 * Проходимость башен — без браузера.
 *
 * Жалоба была «локации непроходимые — слишком маленькие щели»: сосулька
 * висела в двадцати пикселях над карнизом, обломок у стены, укрытие под
 * сталактитом. Генерация теперь сама держит просвет (shapes.js, PASS), а
 * этот набор не даёт ему вернуться: те же карты, что в игре (боями
 * «Подъёма» и испытаниями с их зёрнами, плюс по паре случайных башен
 * каждого вида), собираются тем же кодом и проверяются
 * tools/passability.mjs — нет ли щели уже бойца и не стоит ли старт в
 * закрытом кармане. Полный разбор с сотнями зёрен, ходьбой, прыжками и
 * тросом — node tools/passability.mjs.
 */
import { buildMap, analyze } from '../tools/passability.mjs';
import { towerMatch, ascentMatch, challengeMatch } from '../src/core/match.js';
import { ASCENT } from '../src/campaign/ascent.js';
import { CHALLENGES } from '../src/campaign/challenges.js';
import { TOWER_VARIANTS } from '../src/core/shapes.js';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const maps = [
  ...ASCENT.map((a) => [`«Подъём» ${a.id}`, ascentMatch(a.id), a.seed]),
  ...CHALLENGES.map((c) => [`испытание «${c.id}»`, challengeMatch(c.id), c.seed]),
  ...TOWER_VARIANTS.flatMap((v) => [31337, 777001].map((seed) => [`башня ${v.id} #${seed}`, { ...towerMatch('fighter'), variant: v.id }, seed])),
];

const t0 = Date.now();
for (const [name, match, seed] of maps) {
  // Без графа ходьбы и троса (он долгий): щели и закрытые карманы на старте
  const res = analyze(buildMap(match, seed), { traps: false });
  const bad = [
    ...res.gaps.map((g) => `щель ${g.width}px у (${g.x}, ${g.y})`),
    ...res.sealed.map((s) => `старт (${Math.round(s.x)}, ${Math.round(s.y)}): ${s.why}`),
  ];
  check(`${name}: щелей уже бойца нет, старты не заперты`, !bad.length, bad.slice(0, 3).join('; '));
}
console.log(`  (${maps.length} карт за ${Math.round((Date.now() - t0) / 1000)} с)`);

console.log(failures.length ? `\nне прошло: ${failures.length}` : '\nбашни проходимы');
process.exit(failures.length ? 1 : 0);
