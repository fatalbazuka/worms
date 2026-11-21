/**
 * Почему боец выбыл — коротко, человеческими словами.
 *
 * Слепые игроки говорили, что победа «пришла непонятно за что»: соперник
 * тонул сам, а экран итога молчал. Сцена знает и причину (утонул, взрыв,
 * падение), и кто последним задел бойца в этот ход, — отсюда выкрик у
 * бойца, строка в журнале хода и одна строка на экране итога.
 *
 * Без Phaser и сцены: проверяется в tests/match.mjs.
 */

/**
 * Причина выбывания.
 * @param {{cause:string, hit?:{team:number, weapon:string, who:string|null, turn:number}|null,
 *   turn:number, victimTeam:number, tower?:boolean}} o
 *   hit — кто задел бойца последним (who — «ты», «соперник», имя команды;
 *   null — монстр, бочка, молния). Считается, только если задел в этот ход.
 * @returns {{kind:string, text:string, byTeam:number|null}}
 *   kind: drown — утонул сам (или вода поднялась), off — сбит в воду,
 *   shot — добит, fall — разбился, own — свой огонь, env — стихия и монстры,
 *   gone — выбыл (причина пришла снимком из сети)
 */
export function koCause({ cause, hit = null, turn, victimTeam, tower = true }) {
  const fresh = hit && hit.turn === turn ? hit : null;
  const by = fresh && fresh.who ? `${fresh.weapon} (${fresh.who})` : null;
  const own = fresh && fresh.who && fresh.team === victimTeam;
  if (cause === 'утонул') {
    if (by && !own) return { kind: 'off', text: `${tower ? 'сбит с башни' : 'сбит в воду'}: ${by}`, byTeam: fresh.team };
    return { kind: 'drown', text: 'утонул', byTeam: null };
  }
  if (own) return { kind: 'own', text: `свой огонь: ${fresh.weapon}`, byTeam: fresh.team };
  if (by) return { kind: 'shot', text: `добит: ${by}`, byTeam: fresh.team };
  if (cause === 'падение') return { kind: 'fall', text: 'разбился', byTeam: null };
  if (cause === 'кактус') return { kind: 'env', text: 'добит кактусом', byTeam: null };
  if (cause === 'взрыв' || cause === 'бита' || fresh) return { kind: 'env', text: 'взрыв рядом', byTeam: null };
  return { kind: 'gone', text: 'выбыл', byTeam: null };
}

const one = (n, single, many) => `${n} ${n === 1 ? single : many}`;

/**
 * Одна строка итога: за что победа или поражение.
 *   «Победа: 1 добил ты · 1 утонул», «Поражение: оба твоих бойца утонули».
 * @param {{team:number, kind:string, byTeam:number|null}[]} kos — все выбывшие за бой
 * @param {{won:boolean, myTeam:number, boss?:boolean}} o
 * @returns {string} пусто — сказать нечего (ничья, никто не выбыл)
 */
export function koSummary(kos, { won, myTeam, boss = false }) {
  if (won && boss) return 'Победа: Великан повален';
  // Победа — разбираем выбывших соперников, поражение — своих
  const list = kos.filter((k) => (won ? k.team !== myTeam : k.team === myTeam));
  if (!list.length) return '';
  const head = won ? 'Победа' : 'Поражение';
  if (!won && list.length >= 2 && list.every((k) => k.kind === 'drown')) {
    return `${head}: ${list.length === 2 ? 'оба твоих бойца утонули' : 'все твои бойцы утонули'}`;
  }
  const n = { me: 0, foe: 0, drown: 0, fall: 0, own: 0, env: 0 };
  for (const k of list) {
    if (k.kind === 'shot' || k.kind === 'off') {
      if (k.byTeam === myTeam) n.me++; else n.foe++;
    } else if (k.kind === 'drown') n.drown++;
    else if (k.kind === 'fall') n.fall++;
    else if (k.kind === 'own') n.own++;
    else n.env++;
  }
  const parts = [];
  if (n.me) parts.push(`${n.me} добил ты`);
  if (n.foe) parts.push(`${n.foe} добил соперник`);
  if (n.drown) parts.push(one(n.drown, 'утонул', 'утонули'));
  if (n.fall) parts.push(one(n.fall, 'разбился', 'разбились'));
  if (n.own) parts.push(`${n.own} — свой огонь`);
  if (n.env) parts.push(`${n.env} — монстры и стихия`);
  return parts.length ? `${head}: ${parts.join(' · ')}` : '';
}
