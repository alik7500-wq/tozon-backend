import { buyerEnabled } from './identity.service.js';
import { hashBuyerInviteToken } from './telegram-auth.js';
import { readBuyerUpdateToken } from './queue-privacy.js';
export function buyerAppUrl(token,configured=process.env.BUYER_PORTAL_URL) {
  const url=new URL(configured);
  if (url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/,'')!=='/buyer') throw new Error('BUYER_URL_NOT_CONFIGURED');
  url.hash=token?`invite=${token}`:'';
  return url.toString();
}
export class BuyerBot {
  constructor({repo,enabled=buyerEnabled,url=buyerAppUrl}) { this.repo=repo;this.enabled=enabled;this.url=url; }
  async handle(update,api,{onlyExplicit=false}={}) {
    const m=update.message||update.callback_query?.message;
    const sender=update.callback_query?.from||update.message?.from;
    if (!sender || sender.is_bot || m?.chat?.type!=='private' || String(m.chat.id)!==String(sender.id)) return false;
    const text=update.message?.text||'';
    const send=(text,markup)=>api.send(sender.id,text,markup,{mainMenu:false});
    const explicit=Boolean(update.message?.buyer_invite)||/^\/start(?:@\w+)?\s+buyer_/.test(text)||/^\/buyer(?:@\w+)?$/.test(text)||update.callback_query?.data==='buyer:open';
    if (!explicit && (onlyExplicit || !this.enabled())) return false;
    if (!this.enabled()) {
      if (explicit) await send('Кабинети харидор ҳоло дастрас нест. / Кабинет покупателя пока недоступен.');
      return explicit;
    }
    if (!explicit && !await this.repo.knownTelegram(sender.id)) return false;
    let token;
    try {
      token=readBuyerUpdateToken(update);
      if (/^\/start(?:@\w+)?\s+buyer_/.test(text)&&!token) throw new Error();
      if (token && !await this.repo.visit(hashBuyerInviteToken(token),sender.id)) {
        if(typeof this.repo.access==='function'&&(await this.repo.access(sender.id)).length)token=undefined;else throw new Error();
      }
    } catch {
      await send('Муҳлати QR гузаштааст. Аз менеҷер QR-и нав гиред. / QR недоступен. Попросите менеджера выдать новый.');
      return true;
    }
    let url;
    try { url=this.url(token); } catch {
      await send('Кабинет временно недоступен. Обратитесь к менеджеру.'); return true;
    }
    await send(
      token?'Хуш омадед! Кабинетро кушоед. Менеҷер пайвастшавии Telegram-ро як маротиба тасдиқ мекунад. SMS лозим нест.\n\nДобро пожаловать! Откройте кабинет. Менеджер один раз подтвердит подключение Telegram. SMS не требуется.'
        :'Кабинети шахсии харидор / Личный кабинет покупателя',
      {inline_keyboard:[[{text:'Кабинетро кушодан / Открыть кабинет',web_app:{url}}]]});
    return true;
  }
}
