// Настройки развёртывания. Этот файл подменяется на сервере: в Docker его
// пишет deploy/docker-entrypoint.sh из переменных окружения. Пустые поля —
// значения по умолчанию из src/net/supabase.js и src/platform/telegram.js.
//
// window.WORMS_NET = { url: 'https://<проект>.supabase.co', anonKey: 'sb_publishable_…' };
// window.WORMS_TG  = { bot: 'имя_бота', app: '' };
// window.WORMS_UI  = 'desktop' | 'touch';   // навязать интерфейс всем
// window.WORMS_API = '/api';                 // сервер аккаунтов (по умолчанию /api)
