import { AppError } from '../../shared/errors/errorHandler.js';

export const privileged = user => ['ADMIN', 'DIRECTOR'].includes(user.role);

export function phone(raw) {
  const value = String(raw || '').trim();
  if (!/^[+\d\s().-]+$/.test(value)) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9) digits = `992${digits}`;
  if (digits.length === 10 && digits.startsWith('0')) digits = `992${digits.slice(1)}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

export function settings(env = process.env) {
  if (env.MOIZVONKI_ENABLED !== 'true') throw new AppError('Интеграция «Мои Звонки» ещё не подключена', 503);
  let url;
  try { url = new URL(env.MOIZVONKI_API_URL); } catch { throw new AppError('Не настроен адрес API «Мои Звонки»', 503); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.moizvonki\.ru$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !['/', '/api/v1'].includes(url.pathname)) {
    throw new AppError('Неверный адрес API «Мои Звонки»', 503);
  }
  if (!env.MOIZVONKI_API_KEY) throw new AppError('Не настроен ключ API «Мои Звонки»', 503);
  let mapping;
  try { mapping = JSON.parse(env.MOIZVONKI_USER_MAP || '{}'); } catch { throw new AppError('Неверная настройка пользователей «Мои Звонки»', 503); }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new AppError('Неверная настройка пользователей «Мои Звонки»', 503);
  return { url: `${url.origin}/api/v1`, key: env.MOIZVONKI_API_KEY, mapping, admin: env.MOIZVONKI_ADMIN_EMAIL };
}

export function identity(user, config, history = false) {
  if (history && privileged(user) && config.admin) return { email: config.admin, supervised: 1 };
  const email = config.mapping[String(user.id)];
  if (typeof email !== 'string' || !email.includes('@')) throw new AppError('Ваш рабочий телефон ещё не подключён. Обратитесь к администратору', 503);
  return { email, supervised: 0 };
}

export async function request(config, email, action, params = {}, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(config.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, user_name: email, api_key: config.key, action })
    });
  } catch { throw new AppError('Нет ответа от «Мои Звонки». Проверьте состояние телефона; повторный звонок автоматически не запускается', 502); }
  if (!response.ok) throw new AppError('«Мои Звонки» отклонили запрос. Проверьте настройки подключения', 502);
  try { return await response.json(); } catch { throw new AppError('Некорректный ответ «Мои Звонки»', 502); }
}

export async function history(user, numbers, { config = settings(), fetcher = fetch, now = Date.now() } = {}) {
  const who = identity(user, config, true);
  const wanted = new Set(numbers.map(phone).filter(Boolean));
  const results = new Map();
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const data = await request(config, who.email, 'calls.list', {
      from_date: Math.floor(now / 1000) - 30 * 86400, to_date: Math.floor(now / 1000),
      from_offset: offset, max_results: 100, supervised: who.supervised
    }, fetcher);
    if (!Array.isArray(data?.results)) throw new AppError('Некорректный список звонков от провайдера', 502);
    for (const call of data.results) {
      if (!wanted.has(phone(call.client_number))) continue;
      let recording = null;
      try { const u = new URL(call.recording); if (u.protocol === 'https:' && !u.username && !u.password) recording = u.href; } catch { /* No recording */ }
      results.set(String(call.db_call_id), {
        id: String(call.db_call_id), phone: phone(call.client_number),
        direction: Number(call.direction) === 0 ? 'INCOMING' : 'OUTGOING',
        answered: Number(call.answered) === 1, start_time: Number(call.start_time),
        duration: Number(call.duration) || 0, employee: call.user_account || who.email, recording
      });
    }
    const next = Number(data.results_next_offset || 0);
    if (!next) return { calls: [...results.values()].sort((a,b) => b.start_time-a.start_time), truncated: false, days: 30 };
    if (!Number.isSafeInteger(next) || next <= offset) throw new AppError('Некорректная пагинация «Мои Звонки»', 502);
    offset = next;
  }
  return { calls: [...results.values()].sort((a,b) => b.start_time-a.start_time), truncated: true, days: 30 };
}
