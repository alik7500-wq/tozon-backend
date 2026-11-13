import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import {BuyerBot,buyerAppUrl} from './bot.js';
import {protectBuyerUpdate,readBuyerUpdateToken} from './queue-privacy.js';
import {FinanceBot,TelegramAPI} from '../telegram-finance/bot.js';
import {buyerBot} from './instance.js';
import {TelegramFinanceRepository} from '../telegram-finance/repository.js';
const token='a'.repeat(43),secret='test-bot-key';
const update=(text=`/start buyer_${token}`)=>({update_id:1,message:{from:{id:10},chat:{id:10,type:'private'},text}});
let repo,api,bot;
beforeEach(()=>{
  vi.stubEnv('BUYER_PORTAL_ENABLED','false');
  repo={visit:vi.fn(async()=>true),knownTelegram:vi.fn(async()=>true)};
  api={send:vi.fn()};bot=new BuyerBot({repo,enabled:()=>true,url:t=>buyerAppUrl(t,'https://example.test/buyer')});
});
it('encrypts QR tokens at rest and binds encrypted values to chat/update',()=>{
  const raw=update();const protectedUpdate=protectBuyerUpdate(raw,secret);
  expect(JSON.stringify(protectedUpdate)).not.toContain(token);
  expect(raw.message.text).toContain(token);
  expect(readBuyerUpdateToken(protectedUpdate,secret)).toBe(token);
  expect(()=>readBuyerUpdateToken({...protectedUpdate,update_id:2},secret)).toThrow('BUYER_INVITE_UNAVAILABLE');
  expect(()=>readBuyerUpdateToken(protectedUpdate,'wrong')).toThrow('BUYER_INVITE_UNAVAILABLE');
});
it('does not change ordinary finance updates',()=>{
  const u=update('/rko');expect(protectBuyerUpdate(u,secret)).toBe(u);
});
it('applies queue encryption at the actual repository write boundary',async()=>{
  vi.stubEnv('TELEGRAM_FINANCE_BOT_TOKEN',secret);
  const insert=vi.fn(async()=>({error:null}));const db={from:vi.fn(()=>({insert}))};
  await new TelegramFinanceRepository(db).enqueue(update());
  const stored=insert.mock.calls[0][0];expect(JSON.stringify(stored)).not.toContain(token);
  expect(readBuyerUpdateToken(stored.payload,secret)).toBe(token);
});
it('opens the same buyer Mini App without a finance menu or identity in URL',async()=>{
  expect(await bot.handle(update(),api)).toBe(true);
  const [id,,markup,options]=api.send.mock.calls[0];
  expect(id).toBe(10);expect(markup.inline_keyboard).toHaveLength(1);
  expect(markup.inline_keyboard[0][0].web_app.url).toBe(`https://example.test/buyer#invite=${token}`);
  expect(options).toEqual({mainMenu:false});expect(repo.visit).toHaveBeenCalledOnce();
});
it('rejects expired invites without opening the cabinet',async()=>{
  repo.visit.mockResolvedValue(false);await bot.handle(update(),api);
  expect(api.send.mock.calls[0][1]).toContain('QR недоступен');
  expect(api.send.mock.calls[0][2]).toBeUndefined();
});
it('intercepts buyer start even while feature is disabled, without registering finance access',async()=>{
  const finance={register:vi.fn(),find:vi.fn()};const api={send:vi.fn(),call:vi.fn()};
  const f=new FinanceBot(finance,api,{passport:{handle:vi.fn(async()=>false)}});
  await f.handle(update());
  expect(finance.register).not.toHaveBeenCalled();expect(finance.find).not.toHaveBeenCalled();
  expect(api.send.mock.calls[0][1]).toContain('пока недоступен');
});
it('keeps revoked/known buyers out of staff onboarding on later /start',async()=>{
  expect(await bot.handle(update('/start'),api)).toBe(true);
  expect(repo.knownTelegram).toHaveBeenCalledWith(10);
});
it('prevents ordinary buyer /start from registering or querying financial reports in FinanceBot',async()=>{
  vi.stubEnv('BUYER_PORTAL_ENABLED','true');
  const handler=vi.spyOn(buyerBot,'handle').mockImplementation(async(_u,_a,options)=>!options?.onlyExplicit);
  try{
    const finance={register:vi.fn(),find:vi.fn(async()=>null),snapshot:vi.fn()};
    const f=new FinanceBot(finance,{send:vi.fn()},{passport:{handle:vi.fn(async()=>false)}});
    await f.handle(update('/start'));
    expect(finance.register).not.toHaveBeenCalled();expect(finance.snapshot).not.toHaveBeenCalled();
  }finally{handler.mockRestore();}
});
it('does not intercept ordinary employee commands in explicit-only mode',async()=>{
  expect(await bot.handle(update('/rko'),api,{onlyExplicit:true})).toBe(false);
  expect(repo.knownTelegram).not.toHaveBeenCalled();
});
it('accepts only private sender-matching messages',async()=>{
  const u=update();u.message.chat.id=99;expect(await bot.handle(u,api)).toBe(false);
  u.message.chat.id=10;u.message.chat.type='group';expect(await bot.handle(u,api)).toBe(false);
  expect(repo.visit).not.toHaveBeenCalled();
});
it.each(['http://example.test/buyer','https://user:password@example.test/buyer','https://example.test/other','https://example.test/buyer?secret=x','https://example.test/buyer#bad'])('rejects unsafe cabinet configuration %s',value=>{
  expect(()=>buyerAppUrl(token,value)).toThrow();
});
it('preserves employee main menu and suppresses it only for buyer messages',async()=>{
  const api=new TelegramAPI('test');api.call=vi.fn(async()=>({}));
  await api.send(1,'buyer',undefined,{mainMenu:false});
  expect(api.call.mock.calls[0][1].reply_markup).toBeUndefined();
  await api.send(1,'employee');
  expect(api.call.mock.calls[1][1].reply_markup.inline_keyboard[0][0].callback_data).toBe('main_menu');
});
