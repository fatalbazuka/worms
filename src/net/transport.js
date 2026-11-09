/**
 * Транспорт сетевой игры.
 *
 * Сессия ничего не знает про то, как ходят сообщения — ей нужен объект с
 * connect/send/close. Благодаря этому весь сетевой слой проверяется без
 * интернета: ChannelTransport гоняет сообщения между вкладками одного
 * браузера, а рабочий транспорт (Supabase Realtime) подставляется потом
 * той же парой методов.
 *
 * Формат сообщения: { type, from, ... }. Поле from проставляет транспорт,
 * своё же сообщение он игроку не возвращает.
 */

/**
 * Транспорт между вкладками одного браузера.
 *
 * Это не заглушка: на одном компьютере в двух вкладках так реально можно
 * играть вдвоём, и на нём же гоняются тесты.
 */
export class ChannelTransport {
  constructor() {
    this.id = randomId();
  }

  async connect(room, onMessage) {
    this.channel = new BroadcastChannel(`worms:${room}`);
    this.channel.onmessage = (e) => {
      const msg = e.data;
      if (!msg || msg.from === this.id) return;   // своё эхо не слушаем
      onMessage(msg);
    };
    return this;
  }

  send(msg) {
    this.channel?.postMessage({ ...msg, from: this.id });
  }

  close() {
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }
  }
}

/**
 * Транспорт через Supabase Realtime Broadcast.
 *
 * Важное: используется ТОЛЬКО broadcast — сообщения проходят через сервис
 * и нигде не сохраняются. Ни одной таблицы не читается и не создаётся,
 * SQL не выполняется, миграций нет. Ключ нужен публичный (anon).
 */
export class SupabaseTransport {
  constructor({ url, keys, createClient }) {
    this.id = randomId();
    this.url = url;
    this.keys = keys.filter(Boolean);
    this.createClient = createClient;
  }

  async connect(room, onMessage) {
    // Ключей может быть два: новый publishable и старый anon. Проекты
    // разного возраста принимают на Realtime разные, поэтому пробуем по
    // очереди — иначе «онлайн не работает» без единого внятного признака.
    let last = null;
    for (const key of this.keys) {
      try {
        await this._connectWith(key, room, onMessage);
        return this;
      } catch (e) {
        last = e;
        this.close();
      }
    }
    throw last ?? new Error('нет ключей для Realtime');
  }

  async _connectWith(key, room, onMessage) {
    const client = this.createClient(this.url, key, {
      realtime: { params: { eventsPerSecond: 20 } },
    });
    this.client = client;
    this.channel = client.channel(`worms:${room}`, {
      config: { broadcast: { self: false } },
    });
    this.channel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      if (!payload || payload.from === this.id) return;
      onMessage(payload);
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('нет ответа от Realtime')), 10000);
      this.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          reject(new Error(`Realtime: ${status}`));
        }
      });
    });
  }

  send(msg) {
    this.channel?.send({ type: 'broadcast', event: 'msg', payload: { ...msg, from: this.id } });
  }

  /**
   * Вернулись из фона: iOS убивает сокет у свёрнутого приложения. Клиент
   * Realtime переподключается сам, но не сразу — подталкиваем. Каналы
   * при этом переподписываются автоматически.
   */
  reconnect() {
    const rt = this.client?.realtime;
    if (!rt) return;
    try {
      if (typeof rt.isConnected === 'function' && rt.isConnected()) return;
      rt.connect();
    } catch (e) {
      console.warn('[net] переподключение', e);
    }
  }

  close() {
    // Без этого клиент продолжает долбиться в сокет вечно, даже когда мы
    // уже сдались и играем локально
    this.channel?.unsubscribe();
    this.client?.removeAllChannels();
    this.client?.realtime?.disconnect();
    this.channel = null;
    this.client = null;
  }
}

export function randomId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

/**
 * Скопировать текст в буфер. Современный способ работает не везде
 * (нужен https и разрешение), поэтому есть старый запасной.
 */
export function copyText(text) {
  try {
    navigator.clipboard?.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

/** Код комнаты для ссылки: короткий, без похожих друг на друга символов. */
export { randomRoom } from './rooms.js';
