import {it,expect,vi,afterEach} from 'vitest';
import {FinanceBot} from './bot.js';
afterEach(()=>vi.unstubAllEnvs());
function setup(username){
 const api={token:'synthetic-test-token',call:vi.fn(async method=>method==='getMe'?{username}:method==='getWebhookInfo'?{url:''}:{} )};
 const repo={state:vi.fn(),release:vi.fn()};const bot=new FinanceBot(repo,api);bot.tick=vi.fn(async()=>{});return {bot,repo,api};
}
it('rejects a different bot by default before touching its webhook',async()=>{
 vi.stubEnv('TELEGRAM_FINANCE_BOT_USERNAME','');const {bot,api}=setup('SavorCarBot');
 await expect(bot.start()).rejects.toThrow('UNEXPECTED_FINANCE_BOT');expect(api.call.mock.calls.map(([method])=>method)).toEqual(['getMe']);
});
it('starts the explicitly configured test bot only on its configured webhook',async()=>{
 vi.stubEnv('TELEGRAM_FINANCE_BOT_USERNAME','SavorCarBot');vi.stubEnv('TELEGRAM_FINANCE_WEBHOOK_URL','https://tozon-buyer-test-api.onrender.com/api/telegram-finance/webhook');const {bot,api}=setup('SavorCarBot');
 try{await bot.start();expect(api.call).toHaveBeenCalledWith('setWebhook',expect.objectContaining({url:'https://tozon-buyer-test-api.onrender.com/api/telegram-finance/webhook'}));expect(bot.running).toBe(true);}finally{await bot.stop();}
});
it('requires an explicit webhook for a custom bot and preserves existing webhook conflicts',async()=>{
 vi.stubEnv('TELEGRAM_FINANCE_BOT_USERNAME','SavorCarBot');vi.stubEnv('TELEGRAM_FINANCE_WEBHOOK_URL','');const {bot,repo,api}=setup('SavorCarBot');
 await expect(bot.start()).rejects.toThrow('HTTPS_WEBHOOK_REQUIRED');expect(repo.state).not.toHaveBeenCalled();
 vi.stubEnv('TELEGRAM_FINANCE_WEBHOOK_URL','https://test.example/api/telegram-finance/webhook');api.call.mockImplementation(async method=>method==='getMe'?{username:'SavorCarBot'}:{url:'https://existing.example/hook'});
 await expect(bot.start()).rejects.toThrow('FINANCE_BOT_WEBHOOK_CONFLICT');expect(api.call.mock.calls.some(([method])=>method==='setWebhook')).toBe(false);
});
