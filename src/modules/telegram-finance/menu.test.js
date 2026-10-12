import {it,expect,vi} from 'vitest';
import {withMainMenu,TelegramAPI,FinanceBot} from './bot.js';
it('appends home once and preserves existing navigation without mutation',()=>{
 const markup={inline_keyboard:[[{text:'Следующие',callback_data:'next'}]]};const result=withMainMenu(markup);
 expect(result.inline_keyboard).toHaveLength(2);expect(markup.inline_keyboard).toHaveLength(1);expect(withMainMenu(result)).toBe(result);expect(withMainMenu().inline_keyboard[0][0].callback_data).toBe('main_menu');
});
it('adds home to every split message and keeps other buttons on the final message',async()=>{
 const api=new TelegramAPI('FAKE');api.call=vi.fn();await api.send('123','a'.repeat(8000),{inline_keyboard:[[{text:'Next',callback_data:'next'}]]});
 expect(api.call.mock.calls.length).toBeGreaterThan(1);for(const [,p]of api.call.mock.calls)expect(p.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='main_menu')).toBe(true);
 expect(api.call.mock.calls.at(-1)[1].reply_markup.inline_keyboard[0][0].callback_data).toBe('next');
});
it('returns home from expense entry, cancels only its draft and never posts an expense',async()=>{
 const user={telegram_id:'123',slot:'AKMALKHON',status:'APPROVED'};
 const repo={find:vi.fn(async()=>user),session:vi.fn(async()=>({draft_id:'draft-id'})),cancelDraft:vi.fn(),clearSession:vi.fn(),postExpense:vi.fn()};const api={call:vi.fn(),send:vi.fn()};const bot=new FinanceBot(repo,api);
 await bot.handle({callback_query:{id:'cb',from:{id:123},message:{chat:{id:123,type:'private'}},data:'main_menu'}});
 expect(repo.cancelDraft).toHaveBeenCalledWith('draft-id','123');expect(repo.clearSession).toHaveBeenCalledWith('123');expect(repo.postExpense).not.toHaveBeenCalled();expect(api.send.mock.calls[0][1]).toContain('Главное меню');
});
