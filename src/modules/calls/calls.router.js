import express from 'express';
import rateLimit from 'express-rate-limit';
import { protect } from '../../middleware/auth.middleware.js';
import { LeadsRepository } from '../leads/leads.repository.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { parseRequiredBigInt } from '../../utils/idNormalizer.js';
import { settings, identity, request, history, phone, privileged } from './moizvonki.js';

const router = express.Router();
router.use(protect);
router.use(rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { message: 'Слишком много запросов звонков. Подождите минуту' } }));

async function accessibleLead(req, write = false) {
  const permissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
  if (!privileged(req.user) && !permissions.includes('*') && !permissions.includes('leads.manage') && !(permissions.includes('leads.view') && !write)) {
    throw new AppError('Недостаточно прав для работы со звонками', 403);
  }
  const lead = await LeadsRepository.findById(parseRequiredBigInt(req.params.id, 'id'));
  if (!lead) throw new AppError('Клиент не найден', 404);
  if (!privileged(req.user) && String(lead.responsible_user_id) !== String(req.user.id)) throw new AppError('Нет доступа к звонкам этого клиента', 403);
  return lead;
}

router.get('/leads/:id', async (req, res, next) => {
  try {
    const lead = await accessibleLead(req);
    const data = await history(req.user, [lead.phone, lead.secondary_phone]);
    res.set('Cache-Control', 'no-store').json({ status: 'success', data });
  } catch (error) { next(error); }
});

router.post('/leads/:id/dial', async (req, res, next) => {
  try {
    const lead = await accessibleLead(req, true);
    const number = phone(req.body.secondary === true ? lead.secondary_phone : lead.phone);
    if (!number) throw new AppError('У клиента не указан корректный телефон', 400);
    const config = settings();
    const who = identity(req.user, config);
    await request(config, who.email, 'calls.make_call', { to: number });
    res.json({ status: 'success', data: { message: 'Команда набора передана на ваш телефон. Это ещё не подтверждение соединения' } });
  } catch (error) { next(error); }
});

export default router;
