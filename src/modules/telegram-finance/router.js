import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { TelegramFinanceRepository } from './repository.js';
import { slots, webhookSecret } from './bot.js';
import { getFinanceBot } from './start.js';
import { verifySchedulerToken } from '../../middleware/schedulerAuth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const router = Router();
// A webhook wakes the backend when a recipient opens the bot, including on Render.
router.post('/webhook', rateLimit({ windowMs: 60000, limit: 120 }), async (req, res, next) => {
  try {
    const token = process.env.TELEGRAM_FINANCE_BOT_TOKEN?.trim();
    const given = Buffer.from(req.headers['x-telegram-bot-api-secret-token'] || '');
    const expected = Buffer.from(token ? webhookSecret(token) : '');
    if (!token || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new AppError('Unauthorized webhook', 401);
    const u = req.body;
    if (!Number.isSafeInteger(u.update_id) || u.update_id < 0) throw new AppError('Invalid update', 400);
    // Store only fields needed for commands; callback message text may contain finance.
    const cleanMessage = m => m && ({ from: m.from, chat: { id: m.chat?.id, type: m.chat?.type }, text: m.text, photo: m.photo?.slice(-1).map(p => ({file_id:p.file_id,file_size:p.file_size})) });
    const clean = { update_id: u.update_id };
    if (u.message) clean.message = cleanMessage(u.message);
    if (u.callback_query) clean.callback_query = { id: u.callback_query.id, from: u.callback_query.from, data: u.callback_query.data, message: { chat: { id: u.callback_query.message?.chat?.id, type: u.callback_query.message?.chat?.type } } };
    await new TelegramFinanceRepository().enqueue(clean);
    res.json({ ok: true });
    void getFinanceBot().tick();
  } catch (error) { next(error); }
});
router.post('/run', verifySchedulerToken, async (req, res, next) => {
  try { await getFinanceBot().tick(); res.json({ status: 'success' }); } catch (error) { next(error); }
});
router.use(protect, restrictTo('ADMIN', 'DIRECTOR'));
router.get('/', async (req, res, next) => {
  try {
    const repo = new TelegramFinanceRepository();
    const [subscribers, deliveries, state, cashDesks, crmUsers] = await Promise.all([repo.subscribers(), repo.deliveries(), repo.state(),repo.cashDesks(),repo.crmUsers()]);
    res.json({ status: 'success', data: { tokenConfigured: Boolean(process.env.TELEGRAM_FINANCE_BOT_TOKEN?.trim()), workerActive: Boolean(state.worker_id && new Date(state.lease_until) > new Date()), schedule: '22:00', timezone: 'Asia/Dushanbe', botUrl: 'https://t.me/TozonFinanceBot', slots, subscribers, deliveries,cashDesks,crmUsers } });
  } catch (error) { next(error); }
});
router.put('/subscribers/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const slot = req.body.slot;
    if (!/^[1-9]\d{0,15}$/.test(id) || (slot !== null && !Object.hasOwn(slots, slot))) throw new AppError('Выберите одного из четырёх получателей.', 400);
    const repo = new TelegramFinanceRepository();
    if (!await repo.find(id)) throw new AppError('Сначала пользователь должен запустить бота.', 404);
    const subscriber = await repo.setAccess(id, slot, req.user.id);
    res.json({ status: 'success', data: { subscriber } });
  } catch (error) {
    next(error.code === '23505' ? new AppError('Этот получатель уже привязан к другому Telegram ID. Сначала отзовите прежний доступ.', 409) : error);
  }
});
router.put('/subscribers/:id/cash-access',async(req,res,next)=>{
  try{
    if(!/^[1-9]\d{0,15}$/.test(req.params.id))throw new AppError('Неверный Telegram ID.',400);
    const repo=new TelegramFinanceRepository();const user=await repo.find(req.params.id);
    if(!user)throw new AppError('Получатель не найден.',404);
    const {cash_desk_id,crm_user_id,can_create_expense}=req.body;
    const desks=await repo.cashDesks();const users=await repo.crmUsers();
    if(cash_desk_id!==null&&!desks.some(d=>d.id===cash_desk_id))throw new AppError('Выберите активную кассу.',400);
    if(crm_user_id!==null&&!users.some(u=>String(u.id)===String(crm_user_id)))throw new AppError('Выберите активного пользователя CRM.',400);
    if(typeof can_create_expense!=='boolean'||(can_create_expense&&(!crm_user_id||(user.slot!=='AKMALKHON'&&!cash_desk_id))))throw new AppError('Для ввода РКО необходимы касса и автор.',400);
    const subscriber=await repo.cashAccess(req.params.id,{cash_desk_id,crm_user_id:crm_user_id===null?null:Number(crm_user_id),can_create_expense});
    res.json({status:'success',data:{subscriber}});
  }catch(e){next(e);}
});
export default router;
