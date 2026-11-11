import { player } from '../platform/player.js';
import { findMatch, searchStatus, BAND_OPEN_AFTER } from './matchmaker.js';
import { makeTransport } from './connect.js';
import { isCasualRoom, CASUAL_PREFIX } from './rooms.js';

/**
 * Лобби: кто сейчас онлайн и с кем свести.
 *
 * Присутствие сделано на обычных широковещательных сообщениях, а не на
 * механизме presence конкретного сервиса. Причина простая: транспорт у нас
 * подменяемый (вкладки, Supabase, что угодно потом), и если завязаться на
 * фирменный presence, лобби перестанет работать везде, кроме одного
 * сервиса, и его нечем будет проверить в тестах.
 *
 * Каждый раз в HEARTBEAT шлёт «я здесь» со своим состоянием. Кого не
 * слышно дольше TIMEOUT — считается ушедшим.
 *
 * Подбор без сервера и без арбитра: пару считает matchmaker.js из данных,
 * которые видят обе стороны, поэтому решение у них совпадает. Здесь только
 * присутствие, счётчик ожидания и вход в комнату.
 *
 * Открытые игры («столы», как в «Дураке»): кто нажал «Создать игру», шлёт
 * в heartbeat код своей комнаты — и все в лобби видят его стол. «Войти»
 * — это сообщение join с кодом комнаты: хозяин, услышав его, заходит в
 * комнату, вошедший заходит сразу. Друг по ссылке минует лобби и попадает
 * прямо в партию, поэтому игровая сцена стучится тем же join (knock),
 * иначе хозяин, ждущий на экране стола, ничего бы не узнал.
 *
 * Режимов два, и у каждого свои очереди и столы: «рейтинг» — подбор по
 * рейтингу, бой меняет рейтинг; «без рейтинга» — подбор с кем угодно, сразу,
 * и бой ни на что не влияет. Режим едет в heartbeat (queue), а у стола он
 * зашит в код комнаты (rooms.js). Старый клиент без queue считается
 * рейтинговым.
 */

const HEARTBEAT = 1500;   // мс между «я здесь»
const TIMEOUT = 5000;     // мс молчания, после которых игрок считается ушедшим

export class Lobby {
  constructor(transport) {
    this.transport = transport;
    this.me = player();
    this.peers = new Map();      // id -> { id, name, rating, state, waited, room, seen }
    this.state = 'idle';         // idle | searching | hosting | playing
    this.queue = 'rated';        // rated | casual — режим поиска или стола
    this.room = null;            // код своей открытой игры, пока hosting
    this.searchStart = 0;        // когда нажали «искать» — для ширины коридора
    this.onChange = null;        // сцена перерисовывает список
    this.onMatch = null;         // (room, opponent) — нашли пару
    this.matched = null;
  }

  async start() {
    await this.transport.connect('lobby', (msg) => this._onMessage(msg));
    this._beat();
    this.timer = setInterval(() => this._beat(), HEARTBEAT);
  }

  /** Сколько секунд я уже ищу. Не ищу — ноль. */
  waited() {
    if (this.state !== 'searching' || !this.searchStart) return 0;
    return Math.floor((Date.now() - this.searchStart) / 1000);
  }

  /** Подпись под кнопкой поиска: во что сейчас упирается подбор. */
  statusText() {
    if (this.state !== 'searching') return '';
    if (this.queue === 'casual') return 'Ищем соперника без рейтинга…';
    return searchStatus(this.waited(), this.searching().length);
  }

  /**
   * Сколько человек сейчас ищут бой в этом режиме — вместе со мной, если
   * я тоже ищу. Это и есть «сейчас ищут N» в меню.
   */
  searchingCount(queue = this.queue) {
    const me = this.state === 'searching' && this.queue === queue ? 1 : 0;
    return this.searching(queue).length + me;
  }

  _beat() {
    this._forget();
    this.transport.send({
      type: 'here',
      id: this.me.id,
      name: this.me.name,
      rating: this.me.rating,
      state: this.state,
      queue: this.queue,
      waited: this.waited(),
      room: this.state === 'hosting' ? this.room : undefined,
    });
    if (this.state === 'searching') this._tryMatch();
    this.onChange?.(this.list());
  }

  /** Убрать тех, кого давно не слышно. */
  _forget() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.seen > TIMEOUT) { this.peers.delete(id); changed = true; }
    }
    if (changed) this.onChange?.(this.list());
  }

  _onMessage(msg) {
    if (msg.type === 'here' && msg.id && msg.id !== this.me.id) {
      this.peers.set(msg.id, {
        id: msg.id, name: msg.name, rating: msg.rating,
        state: msg.state, queue: msg.queue === 'casual' ? 'casual' : 'rated',
        waited: msg.waited ?? 0, room: msg.room ?? null, seen: Date.now(),
      });
      if (this.state === 'searching') this._tryMatch();
      this.onChange?.(this.list());
      return;
    }
    // Кто-то вошёл в мою открытую игру — иду в комнату
    if (msg.type === 'join' && this.state === 'hosting' && msg.room === this.room) {
      const peer = this.peers.get(msg.from) ?? (msg.name ? { name: msg.name, rating: msg.rating } : null);
      this._enter(this.room, peer);
    }
  }

  list() {
    return [...this.peers.values()].sort((a, b) => b.rating - a.rating);
  }

  /**
   * Открытые игры: кто ждёт соперника за своим столом. С queue — только
   * столы этого режима (режим стола — по коду его комнаты).
   */
  tables(queue = null) {
    return [...this.peers.values()]
      .filter((p) => p.state === 'hosting' && p.room)
      .filter((p) => !queue || (queue === 'casual') === isCasualRoom(p.room))
      .sort((a, b) => b.rating - a.rating);
  }

  /** Открыть свою игру: стол виден всем, ждём, пока кто-то войдёт. */
  host(room) {
    this.state = 'hosting';
    this.queue = isCasualRoom(room) ? 'casual' : 'rated';
    this.room = room;
    this.matched = null;
    this.searchStart = 0;
    this._beat();
  }

  /** Передумал ждать. */
  unhost() {
    if (this.state !== 'hosting') return;
    this.state = 'idle';
    this.room = null;
    this._beat();
  }

  /** В бою: в списке виден, но не как стол и не как ищущий. */
  busy() {
    this.state = 'playing';
    this.room = null;
    this.searchStart = 0;
  }

  /** Снова в меню: можно искать, создавать и входить. */
  idle() {
    this.state = 'idle';
    this.room = null;
    this.searchStart = 0;
    this.matched = null;
  }

  /**
   * Войти в чужую открытую игру. Сообщение шлётся трижды: одно может
   * потеряться, а хозяин, не услышав его, так и останется ждать.
   */
  join(peerId) {
    const t = this.peers.get(peerId);
    if (!t?.room || t.state !== 'hosting') return null;
    const msg = {
      type: 'join', room: t.room, from: this.me.id,
      name: this.me.name, rating: this.me.rating,
    };
    this.transport.send(msg);
    setTimeout(() => this.transport.send(msg), 1000);
    setTimeout(() => this.transport.send(msg), 2500);
    this.matched = null;
    this._enter(t.room, t);
    return t.room;
  }

  /** Только те, кто тоже ищет бой — в том же режиме. */
  searching(queue = this.queue) {
    return [...this.peers.values()].filter((p) => p.state === 'searching' && p.queue === queue);
  }

  search(on = true, queue = this.queue) {
    if (on) this.queue = queue === 'casual' ? 'casual' : 'rated';
    this.state = on ? 'searching' : 'idle';
    this.searchStart = on ? Date.now() : 0;
    this.matched = null;
    this._beat();
  }

  /** Пару считает matchmaker: одинаковые данные — одинаковый ответ у обоих. */
  _tryMatch() {
    if (this.matched) return;
    // Без рейтинга подходит любой и сразу: для подбора все будто ждали
    // достаточно, чтобы коридор открылся полностью. Пары по-прежнему
    // считаются одинаково у обоих — входные данные те же.
    const casual = this.queue === 'casual';
    const waited = (p) => (casual ? BAND_OPEN_AFTER : p.waited);
    const me = { id: this.me.id, rating: this.me.rating, waited: casual ? BAND_OPEN_AFTER : this.waited() };
    const others = this.searching().map((p) => ({ ...p, waited: waited(p), ref: p }));
    const found = findMatch(me, others);
    if (!found) return;
    const peer = found.peer.ref ?? found.peer;
    this._enter(roomFor(this.me.id, peer.id, casual), peer);
  }

  _enter(room, opponent) {
    if (this.matched) return;
    this.matched = room;
    this.state = 'idle';
    this.room = null;
    this.searchStart = 0;
    this.onMatch?.(room, opponent ?? null);
  }

  destroy() {
    clearInterval(this.timer);
    this.transport.close();
  }
}

/**
 * Постучаться в комнату через лобби — для того, кто пришёл по ссылке,
 * минуя лобби: хозяин ждёт на экране стола и слушает только join. Своего
 * лобби у такого игрока нет, поэтому канал открывается на несколько
 * секунд и закрывается.
 */
export async function knock(room) {
  const me = player();
  const msg = { type: 'join', room, from: me.id, name: me.name, rating: me.rating };
  try {
    const transport = await makeTransport();
    await transport.connect('lobby', () => {});
    transport.send(msg);
    setTimeout(() => transport.send(msg), 1000);
    setTimeout(() => transport.send(msg), 2500);
    setTimeout(() => transport.close(), 4000);
  } catch (e) {
    console.warn('[лобби] постучаться не вышло', e);
  }
}

/**
 * Код комнаты из пары идентификаторов. Порядок не важен — сортируем,
 * чтобы обе стороны получили одно и то же, не договариваясь.
 */
export function roomFor(a, b, casual = false) {
  const key = [a, b].sort().join('|');
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  // Рейтинговый подбор — «M…», без рейтинга — «Z…» (см. rooms.js)
  let out = casual ? CASUAL_PREFIX : 'M';
  let n = h >>> 0;
  for (let i = 0; i < 5; i++) { out += abc[n % abc.length]; n = Math.floor(n / abc.length); }
  return out;
}
