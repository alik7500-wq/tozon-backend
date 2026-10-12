import crypto from 'node:crypto';
import { buildReport, renderReport, periodFor, validDay, localDay, dailyDue, splitMessage } from './report.js';
import { cashCommand, scopeSnapshot } from './cash.js';

export const slots = { AKMALKHON: 'Акмалхон', ILHOM: 'Илхом', ASRORKHON: 'Асрорхон', MUBINCHON: 'Мубинчон' };
export const roleFor = user => user.slot === 'AKMALKHON' ? 'OWNER' : 'PARTNER';
export const webhookSecret = token => crypto.createHmac('sha256', token).update('tozon-finance-webhook-v1').digest('hex');
export function withMainMenu(markup) {
  const rows=markup?.inline_keyboard||[];
  if(rows.some(row=>row.some(button=>button.callback_data==='main_menu')))return markup;
  return {...markup,inline_keyboard:[...rows,[{text:'🏠 В главное меню',callback_data:'main_menu'}]]};
}
export function keyboard(role) {
  const rows = [[{ text: 'Сегодня', callback_data: 'summary:today' }, { text: 'Вчера', callback_data: 'summary:yesterday' }], [{ text: 'За месяц', callback_data: 'summary:month' }], [{ text: 'Продажи', callback_data: 'sales:today' }, { text: 'Остатки касс', callback_data: 'cash:today' }], [{ text: 'Движение средств', callback_data: 'movement:today' }]];
  rows.push([{ text: 'ПКО — операции', callback_data: 'bookpick:income' },{ text: 'РКО — операции', callback_data: 'bookpick:expense' }]);
  rows.push([{ text: 'Добавить РКО', callback_data: 'rnew' }]);
  rows.push([{ text: 'Расходы подробно', callback_data: 'details:today' }]);
  rows.push([{ text: 'Выбрать период', callback_data: 'help' }]);
  return { inline_keyboard: rows };
}
export class TelegramAPI {
  constructor(token, fetchImpl = fetch) { this.token = token; this.fetch = fetchImpl; }
  async call(method, payload = {}) {
    let response;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(method === 'getUpdates' ? 30000 : 15000) });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const error = new Error('TELEGRAM_REQUEST_FAILED');
        error.code = data.error_code || response.status;
        error.retryAfter = data.parameters?.retry_after;
        throw error;
      }
      return data.result;
    } catch (error) {
      // Never propagate a fetch exception containing the token-bearing URL.
      const safe = new Error('TELEGRAM_REQUEST_FAILED');
      safe.code = error.code || 'NETWORK';
      safe.retryAfter = error.retryAfter;
      throw safe;
    }
  }
  async send(chatId, text, markup, options={}) {
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) await this.call('sendMessage', { chat_id: chatId, text: parts[i], ...(options.html?{parse_mode:'HTML'}:{}),reply_markup:withMainMenu(i===parts.length-1?markup:undefined) });
  }
}

export class FinanceBot {
  constructor(repo, api, { clock = () => new Date(), logger = console } = {}) { this.repo = repo; this.api = api; this.clock = clock; this.logger = logger; this.worker = crypto.randomUUID(); this.running = false; this.busy = false; this.lastRequests = new Map(); }
  async report(user, view = 'summary', period = 'today', custom) {
    const { from, to } = custom || periodFor(period, this.clock());
    // Recheck access immediately before reading financial information.
    const fresh = await this.repo.find(user.telegram_id);
    if (fresh?.status !== 'APPROVED') return;
    if(roleFor(fresh)!=='OWNER'&&!fresh.cash_desk_id){await this.api.send(user.telegram_id,'Ваша касса ещё не назначена в настройках CRM.');return;}
    const report = buildReport(scopeSnapshot(fresh,await this.repo.snapshot()), from, to, this.clock());
    const stillAllowed = await this.repo.find(user.telegram_id);
    if (stillAllowed?.status !== 'APPROVED' || stillAllowed.slot !== fresh.slot || stillAllowed.cash_desk_id!==fresh.cash_desk_id) return;
    await this.api.send(user.telegram_id, renderReport(report, view, 'OWNER'), keyboard(roleFor(stillAllowed)));
  }
  async handle(update) {
    const callback = update.callback_query;
    const message = callback?.message || update.message;
    const sender = callback?.from || message?.from;
    if (!sender || sender.is_bot || message?.chat?.type !== 'private' || String(message.chat.id) !== String(sender.id)) return;
    if (callback) await this.api.call('answerCallbackQuery', { callback_query_id: callback.id });
    const text = message.text || '';
    if (!callback && /^\/start(?:\s|$)/.test(text)) await this.repo.register(sender);
    const user = await this.repo.find(sender.id);
    if (user?.status !== 'APPROVED') {
      await this.api.send(sender.id, `Доступ к финансовым отчётам закрыт. Ваш Telegram ID: ${sender.id}.\n${user?.status === 'REVOKED' ? 'Доступ отозван.' : 'Заявка ожидает подтверждения Акмалхона в настройках TOZON CRM.'}`);
      return;
    }
    const command = callback?.data || text.trim();
    if(command==='main_menu'||command==='/menu') {
      const session=await this.repo.session(user.telegram_id);
      if(session?.draft_id)await this.repo.cancelDraft(session.draft_id,user.telegram_id);
      await this.repo.clearSession(user.telegram_id);
      await this.api.send(user.telegram_id,'🏠 Главное меню\nВыберите нужный раздел:',keyboard(roleFor(user)));
      return;
    }
    if(await cashCommand(this,user,command,Boolean(callback)))return;
    const last = this.lastRequests.get(sender.id) || 0;
    if (this.clock().getTime() - last < 2000) return;
    this.lastRequests.set(sender.id, this.clock().getTime());
    if (this.lastRequests.size > 100) this.lastRequests.clear();
    if (command === 'help' || /^\/help$/.test(command)) {
      await this.api.send(sender.id, 'Отчёты ежедневно в 22:00 по Худжанду.\nПКО: /pko · РКО: /rko_list · Добавить РКО: /rko · Отмена ввода: /cancel\nЗа дату: /report 2026-10-11\nЗа период: /report 2026-10-01 2026-10-11\nСегодня: /today · Вчера: /yesterday · Месяц: /month\nКассовые операции доступны только по назначенной кассе; Акмалхону — по всем.', keyboard(roleFor(user)));
      return;
    }
    if (command.startsWith('/report')) {
      const [, from, end, extra] = command.split(/\s+/);
      const to = end || from;
      if (extra || !validDay(from) || !validDay(to) || from > to || to > localDay(this.clock())) {
        await this.api.send(sender.id, 'Укажите корректные даты: /report ГГГГ-ММ-ДД [ГГГГ-ММ-ДД]. Даты в будущем недоступны.'); return;
      }
      await this.report(user, 'summary', 'today', { from, to }); return;
    }
    if (/^(summary|sales|cash|movement|details):(today|yesterday|month)$/.test(command)) {
      const [view, period] = command.split(':'); await this.report(user, view, period); return;
    }
    const period = /^\/(today|yesterday|month)$/.exec(command)?.[1];
    if (period || /^\/start(?:\s|$)/.test(command)) { await this.report(user, 'summary', period || 'today'); return; }
    await this.api.send(sender.id, 'Выберите отчёт или отправьте /help.', keyboard(roleFor(user)));
  }
  async daily() {
    if (!dailyDue(this.clock())) return;
    const minute = Math.floor(this.clock().getTime() / 60000);
    if (this.lastDailyMinute === minute) return;
    this.lastDailyMinute = minute;
    const date = localDay(this.clock());
    const alreadyClaimed = new Set((await this.repo.deliveries(date)).map(d => d.telegram_id));
    const users = (await this.repo.subscribers()).filter(u => u.status === 'APPROVED' && !alreadyClaimed.has(u.telegram_id));
    if (!users.length) return;
    // Prepare and validate once before claiming any delivery.
    const snapshot = await this.repo.snapshot();
    for (const user of users) {
      if (!await this.repo.claimLease(this.worker)) return;
      const fresh = await this.repo.find(user.telegram_id);
      if (fresh?.status !== 'APPROVED') continue;
      if(roleFor(fresh)!=='OWNER'&&!fresh.cash_desk_id)continue;
      const report=buildReport(scopeSnapshot(fresh,snapshot),date,date,this.clock());
      const delivery = await this.repo.beginDelivery(user.telegram_id, date);
      if (!delivery) continue;
      try {
        await this.api.send(user.telegram_id, renderReport(report), keyboard(roleFor(fresh)));
        await this.repo.finishDelivery(user.telegram_id, date, 'SENT');
      } catch {
        // Network timeout can mean Telegram accepted the message. Do not resend automatically.
        await this.repo.finishDelivery(user.telegram_id, date, 'UNKNOWN');
        this.logger.warn('Telegram finance delivery requires review');
      }
    }
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!await this.repo.claimLease(this.worker)) return;
      if (!this.diagnosticsAt || this.clock().getTime() - this.diagnosticsAt > 30000) {
        try {
          const info = await this.api.call('getWebhookInfo');
          const message = info.last_error_message || '';
          this.diagnostics = { pending_updates: info.pending_update_count || 0, webhook_registered: Boolean(info.url), last_error_at: info.last_error_date || null, delivery_error: message ? (/\b[45]\d\d\b/.exec(message)?.[0] || (/timed out/i.test(message) ? 'TIMEOUT' : /SSL|TLS|certificate/i.test(message) ? 'TLS' : 'DELIVERY_ERROR')) : null };
          this.diagnosticsAt = this.clock().getTime();
        } catch { /* Do not block report processing on diagnostics. */ }
      }
      try { await this.daily(); } catch { this.logger.warn('Telegram finance daily report unavailable'); }
      const updates = await this.repo.pending();
      for (const item of updates) {
        const update = item.payload;
        // Lease renewal prevents a slow report from overlapping a replacement worker.
        if (!await this.repo.claimLease(this.worker)) return;
        await this.repo.updateStatus(item.update_id, 'PROCESSING');
        try { await this.handle(update); }
        catch {
          this.logger.warn('Telegram finance update failed');
          const chat = update.callback_query?.message?.chat || update.message?.chat;
          if (chat?.type === 'private') {
            try { await this.api.send(chat.id, 'Отчёт временно недоступен. Повторите запрос позже.'); } catch { /* redacted */ }
          }
        }
        await this.repo.updateStatus(item.update_id, 'DONE');
      }
    } catch { this.logger.warn('Telegram finance worker temporarily unavailable'); }
    finally { this.busy = false; }
  }
  async start() {
    const bot = await this.api.call('getMe');
    if (bot.username?.toLowerCase() !== 'tozonfinancebot') throw new Error('UNEXPECTED_FINANCE_BOT');
    await this.repo.state();
    const url = process.env.TELEGRAM_FINANCE_WEBHOOK_URL || 'https://tozon-backend.onrender.com/api/telegram-finance/webhook';
    if (!url.startsWith('https://')) throw new Error('HTTPS_WEBHOOK_REQUIRED');
    const webhook = await this.api.call('getWebhookInfo');
    if (webhook.url && webhook.url !== url) throw new Error('FINANCE_BOT_WEBHOOK_CONFLICT');
    await this.api.call('setWebhook', { url, secret_token: webhookSecret(this.api.token), allowed_updates: ['message', 'callback_query'] });
    await this.api.call('setMyCommands', {commands:[{command:'start',description:'Меню'},{command:'pko',description:'Операции ПКО'},{command:'rko_list',description:'Операции РКО'},{command:'rko',description:'Ввести новый РКО'},{command:'cancel',description:'Отменить ввод'},{command:'today',description:'Сегодня'},{command:'yesterday',description:'Вчера'},{command:'month',description:'За месяц'},{command:'report',description:'Выбранный период'},{command:'help',description:'Помощь'}]});
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => { if (this.running) void this.tick(); }, 5000);
    this.timer.unref();
  }
  async stop() { this.running = false; clearInterval(this.timer); if (!this.busy) await this.repo.release(this.worker); }
}
