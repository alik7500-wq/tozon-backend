import { it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
const state = vi.hoisted(() => ({ enqueue: vi.fn(), tick: vi.fn(), setAccess: vi.fn(), find: vi.fn(), subscribers: vi.fn(), deliveries: vi.fn(), state: vi.fn(),cashDesks:vi.fn(),crmUsers:vi.fn(),cashAccess:vi.fn() }));
vi.mock('./repository.js', () => ({ TelegramFinanceRepository: class { constructor() { Object.assign(this, state); } } }));
vi.mock('./start.js', () => ({ getFinanceBot: () => ({ tick: state.tick }) }));
vi.mock('../../middleware/auth.middleware.js', () => ({ protect: (req, res, next) => { if (!req.headers['x-test-role']) return res.sendStatus(401); req.user = { id: 1, role: req.headers['x-test-role'] }; next(); }, restrictTo: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.sendStatus(403) }));
import router from './router.js';
import { webhookSecret } from './bot.js';
const app = express(); app.use(express.json()); app.use('/bot', router); app.use((e, req, res, next) => res.status(e.statusCode || 500).json({ message: e.message }));
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('TELEGRAM_FINANCE_BOT_TOKEN', 'FAKE_TEST_TOKEN'); vi.stubEnv('SMS_SCHEDULER_INTERNAL_TOKEN', 'FAKE_CRON_TOKEN'); state.find.mockResolvedValue({ telegram_id: '12345' }); state.subscribers.mockResolvedValue([]); state.deliveries.mockResolvedValue([]); state.state.mockResolvedValue({ lease_until: '2000-01-01' }); });
it('denies anonymous and staff access before reading subscribers', async () => {
  expect((await request(app).get('/bot')).status).toBe(401); expect((await request(app).get('/bot').set('x-test-role', 'MANAGER')).status).toBe(403); expect(state.subscribers).not.toHaveBeenCalled();
  expect((await request(app).put('/bot/subscribers/12345').set('x-test-role', 'MANAGER').send({ slot: 'AKMALKHON' })).status).toBe(403); expect(state.setAccess).not.toHaveBeenCalled();
});
it('validates the four fixed roles and uses the exact Telegram ID', async () => {
  expect((await request(app).put('/bot/subscribers/12345').set('x-test-role', 'ADMIN').send({ slot: 'UNKNOWN' })).status).toBe(400);
  expect((await request(app).put('/bot/subscribers/12345').set('x-test-role', 'ADMIN').send({ slot: 'ILHOM' })).status).toBe(200); expect(state.setAccess).toHaveBeenCalledWith('12345', 'ILHOM', 1);
});
it('authenticates the webhook and excludes old financial message text from its queue', async () => {
  const u = { update_id: 1, callback_query: { id: 'cb', from: { id: 12345 }, data: 'summary:today', message: { chat: { id: 12345, type: 'private' }, text: 'PRIVATE FINANCIAL REPORT' } } };
  expect((await request(app).post('/bot/webhook').send(u)).status).toBe(401); expect(state.enqueue).not.toHaveBeenCalled();
  expect((await request(app).post('/bot/webhook').set('x-telegram-bot-api-secret-token', webhookSecret('FAKE_TEST_TOKEN')).send(u)).status).toBe(200); expect(JSON.stringify(state.enqueue.mock.calls)).not.toContain('PRIVATE FINANCIAL REPORT'); expect(state.tick).toHaveBeenCalled();
});
it('protects the external daily scheduler', async () => {
  expect((await request(app).post('/bot/run')).status).toBe(401);
  expect((await request(app).post('/bot/run').set('Authorization', 'Bearer FAKE_CRON_TOKEN')).status).toBe(200);
});
it('registers the bot router before broad authenticated API routers', () => {
  const source = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  const bot = source.indexOf("app.use('/api/telegram-finance', telegramFinanceRouter)");
  expect(bot).toBeGreaterThan(0);
  for (const router of ['visual3dRouter', 'tour360Router', 'projectMediaRouter']) {
    expect(bot).toBeLessThan(source.indexOf(`app.use('/api', ${router})`));
  }
});
it('limits cash assignment to admins and requires a real cashier for expense creation',async()=>{
 state.cashDesks.mockResolvedValue([{id:'desk-a'}]);state.crmUsers.mockResolvedValue([{id:2}]);
 expect((await request(app).put('/bot/subscribers/12345/cash-access').set('x-test-role','MANAGER').send({})).status).toBe(403);
 expect((await request(app).put('/bot/subscribers/12345/cash-access').set('x-test-role','ADMIN').send({cash_desk_id:'desk-a',crm_user_id:null,can_create_expense:true})).status).toBe(400);
 expect(state.cashAccess).not.toHaveBeenCalled();
 expect((await request(app).put('/bot/subscribers/12345/cash-access').set('x-test-role','ADMIN').send({cash_desk_id:'desk-a',crm_user_id:2,can_create_expense:true})).status).toBe(200);
 expect(state.cashAccess).toHaveBeenCalledWith('12345',{cash_desk_id:'desk-a',crm_user_id:2,can_create_expense:true});
});
