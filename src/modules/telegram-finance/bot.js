import { passportBridge } from '../passport-bridge/service.js';
import { buyerBot } from '../buyer-portal/instance.js';
import {syncSheets} from './sheets-sync.js';
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
    for (let i = 0; i < parts.length; i++) {
      const buttons=i===parts.length-1?markup:undefined;
      await this.call('sendMessage', { chat_id: chatId, text: parts[i], ...(options.html?{parse_mode:'HTML'}:{}),reply_markup:options.mainMenu===false?buttons:withMainMenu(buttons) });
    }
  }
}

export class FinanceBot {
  constructor(repo, api, { clock = () => new Date(), logger = console, passport = passportBridge, sync = syncSheets, maxConcurrentChats = 4 } = {}) { this.repo = repo; this.api = api; this.passport = passport; this.sync = sync; this.maxConcurrentChats = maxConcurrentChats; this.inFlight = new Map(); this.stopping = false; this.performance = { processed: 0, last_queue_wait_ms: null, last_processing_ms: null }; this.clock = clock; this.logger = logger; this.worker = crypto.randomUUID(); this.running = false; this.busy = false; this.lastRequests = new Map(); }
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
    if (await buyerBot.handle(update,this.api,{onlyExplicit:true})) return;
    if (await this.passport.handle(update, this.api)) return;
    const text = message.text || '';
    // Existing approved employees retain their finance menu. Buyer identity grants no finance role.
    if (process.env.BUYER_PORTAL_ENABLED==='true') {
      const employee=await this.repo.find(sender.id);
      if (employee?.status!=='APPROVED' && await buyerBot.handle(update,this.api)) return;
    }
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
    const last = this.lastRequests.get(sender.id);
    if (last?.command===command && this.clock().getTime()-last.at<2000) return;
    this.lastRequests.set(sender.id, {command,at:this.clock().getTime()});
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
  async processUpdate(item) {
    const started = this.clock().getTime();
    const queued = Date.parse(item.created_at);
    this.performance.last_queue_wait_ms = Number.isFinite(queued) ? Math.max(0, started-queued) : null;
    const update = item.payload;
    try { await this.handle(update); }
    catch {
      this.logger.warn('Telegram finance update failed');
      const chat = update.callback_query?.message?.chat || update.message?.chat;
      if (chat?.type === 'private') {
        try { await this.api.send(chat.id, 'Запрос временно недоступен. Повторите позже.'); } catch { /* redacted */ }
      }
    }
    await this.repo.updateStatus(item.update_id, 'DONE');
    this.performance.processed++;
    this.performance.last_processing_ms = Math.max(0, this.clock().getTime()-started);
  }
  async maintenance() {
    if (!this.diagnosticsAt || this.clock().getTime()-this.diagnosticsAt>30000) {
      this.diagnosticsAt=this.clock().getTime();
      try {
        const info=await this.api.call('getWebhookInfo');
        const message=info.last_error_message||'';
        this.diagnostics={pending_updates:info.pending_update_count||0,webhook_registered:Boolean(info.url),last_error_at:info.last_error_date||null,delivery_error:message?(/\b[45]\d\d\b/.exec(message)?.[0]||(/timed out/i.test(message)?'TIMEOUT':/SSL|TLS|certificate/i.test(message)?'TLS':'DELIVERY_ERROR')):null};
      } catch { /* Diagnostics must not delay user messages. */ }
    }
    if (!this.passportCleanupAt || this.clock().getTime()-this.passportCleanupAt>60000) {
      this.passportCleanupAt=this.clock().getTime();
      try { await this.passport.cleanup(); } catch { /* Retry maintenance later. */ }
    }
    try { await this.daily(); } catch { this.logger.warn('Telegram finance daily report unavailable'); }
    try { await this.sync(this.repo); } catch { this.logger.warn('Telegram sheets sync unavailable'); }
  }
  async tick() {
    if(this.stopping)return;
    // A webhook received while dispatching must be handled on the next microtask,
    // not discarded until the five-second safety poll.
    if(this.busy){this.wakeAgain=true;return;}
    this.busy=true;
    this.dispatchIdle=new Promise(resolve=>{this.resolveDispatchIdle=resolve;});
    try {
      if(!await this.repo.claimLease(this.worker))return;
      const updates=await this.repo.pending();
      for(const item of updates) {
        if(this.stopping)break;
        const u=item.payload;
        const chat=u.callback_query?.message?.chat||u.message?.chat;
        const key=chat?.id!=null?String(chat.id):`invalid:${item.update_id}`;
        if(this.inFlight.has(key))continue;
        if(this.inFlight.size>=this.maxConcurrentChats)break;
        // Compare-and-set also prevents duplicate work during a replica handover.
        if(!await this.repo.claimUpdate(item.update_id))continue;
        const task=Promise.resolve().then(()=>this.processUpdate(item))
          .catch(()=>this.logger.warn('Telegram update completion unavailable'))
          .finally(()=>{
            this.inFlight.delete(key);
            if(!this.stopping)void this.tick();
          });
        this.inFlight.set(key,task);
      }
      // Independent background work has its own busy guard and never occupies a
      // conversation slot. The periodic tick renews the global worker lease.
      if(!this.maintenanceTask && (this.maintenanceAt==null||this.clock().getTime()-this.maintenanceAt>=5000)) {
        this.maintenanceAt=this.clock().getTime();
        this.maintenanceTask=this.maintenance().catch(()=>this.logger.warn('Telegram background maintenance unavailable')).finally(()=>{this.maintenanceTask=null;});
      }
    } catch {this.logger.warn('Telegram finance dispatcher temporarily unavailable');}
    finally {
      this.busy=false;
      this.resolveDispatchIdle?.();
      if(this.wakeAgain&&!this.stopping){this.wakeAgain=false;queueMicrotask(()=>{void this.tick();});}
    }
  }
  async start() {
    const bot = await this.api.call('getMe');
    const expected=(process.env.TELEGRAM_FINANCE_BOT_USERNAME||'tozonfinancebot').replace(/^@/,'').toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(expected) || bot.username?.toLowerCase() !== expected) throw new Error('UNEXPECTED_FINANCE_BOT');
    // A separately configured bot must never inherit the production webhook implicitly.
    const url=process.env.TELEGRAM_FINANCE_WEBHOOK_URL||(expected==='tozonfinancebot'?'https://tozon-backend.onrender.com/api/telegram-finance/webhook':'');
    if (!url.startsWith('https://')) throw new Error('HTTPS_WEBHOOK_REQUIRED');
    await this.repo.state();
    const webhook = await this.api.call('getWebhookInfo');
    if (webhook.url && webhook.url !== url) throw new Error('FINANCE_BOT_WEBHOOK_CONFLICT');
    await this.api.call('setWebhook', { url, secret_token: webhookSecret(this.api.token), allowed_updates: ['message', 'callback_query'] });
    await this.api.call('setMyCommands', {commands:[{command:'start',description:'Меню'},{command:'pko',description:'Операции ПКО'},{command:'rko_list',description:'Операции РКО'},{command:'rko',description:'Ввести новый РКО'},{command:'cancel',description:'Отменить ввод'},{command:'today',description:'Сегодня'},{command:'yesterday',description:'Вчера'},{command:'month',description:'За месяц'},{command:'report',description:'Выбранный период'},{command:'help',description:'Помощь'}]});
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => { if (this.running) void this.tick(); }, 5000);
    this.timer.unref();
  }
  async stop() { this.stopping=true; this.running=false; clearInterval(this.timer); await this.dispatchIdle; await Promise.allSettled([...this.inFlight.values(),...(this.maintenanceTask?[this.maintenanceTask]:[])]); await this.repo.release(this.worker); }
}
