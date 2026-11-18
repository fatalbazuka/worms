/**
 * Эмоции в бою: смайлик корчит рожу и говорит короткую фразу в пузыре.
 *
 * Лицо — кадр того же листа, что и боец (у всех скинов раскладка одна),
 * поэтому эмоция всегда в скине игрока. По сети уходит только id эмоции;
 * чужой id, которого нет в списке, не показывается.
 */
export const EMOTES = [
  { id: 'laugh', text: 'Ха-ха!', pose: 'worm_win' },
  { id: 'angry', text: 'Ну всё!', pose: 'worm_aim' },
  { id: 'cry', text: 'Ну за что…', pose: 'worm_cry' },
  { id: 'oops', text: 'Мимо!', pose: 'worm_dizzy' },
  { id: 'wow', text: 'Ого!', pose: 'worm_hurt' },
  { id: 'gg', text: 'Хорошая игра!', pose: 'worm_win' },
];

export const EMOTE_BY_ID = Object.fromEntries(EMOTES.map((e) => [e.id, e]));

/** Не чаще раза в столько мс — чтобы эмоциями нельзя было заспамить. */
export const EMOTE_COOLDOWN = 2500;
