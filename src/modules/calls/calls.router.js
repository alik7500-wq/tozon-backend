import express from 'express';
import rateLimit from 'express-rate-limit';
import { protect } from '../../middleware/auth.middleware.js';
import { LeadsRepository } from '../leads/leads.repository.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { parseRequiredBigInt } from '../../utils/idNormalizer.js';
import { settings, identity, request, history, phone, privileged } from './moizvonki.js';
import { getServiceDB, getDB } from '../../db/connection.js';
import { TasksRepository } from '../tasks/tasks.repository.js';

const getSafeDB = () => {
  try { return getServiceDB(); } catch { return getDB(); }
};

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

// F-20: Call AI Analysis endpoints (honest status: NOT_CONFIGURED / NO_RECORDING / READY)
router.get('/leads/:id/ai-analyses', async (req, res, next) => {
  try {
    const lead = await accessibleLead(req);
    const db = getSafeDB();
    const aiConfigured = Boolean(process.env.OPENAI_API_KEY && process.env.CALL_AI_ANALYSIS_ENABLED === 'true');
    const { data, error } = await db
      .from('call_ai_analyses')
      .select('*')
      .eq('lead_id', lead.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.json({ status: 'success', data: { aiConfigured, analyses: [] } });
    }
    res.json({ status: 'success', data: { aiConfigured, analyses: data || [] } });
  } catch (error) { next(error); }
});

router.post('/leads/:id/ai-analyses', async (req, res, next) => {
  try {
    const lead = await accessibleLead(req, true);
    const aiConfigured = Boolean(process.env.OPENAI_API_KEY && process.env.CALL_AI_ANALYSIS_ENABLED === 'true');
    const hasRecording = Boolean(req.body?.recording_url || req.body?.recording_available);
    const status = !aiConfigured ? 'NOT_CONFIGURED' : !hasRecording ? 'NO_RECORDING' : 'QUEUED';
    const db = getSafeDB();
    const { data, error } = await db
      .from('call_ai_analyses')
      .insert([{
        lead_id: lead.id,
        communication_id: req.body?.communication_id || null,
        status,
        checklist_version: 'v1.0',
        idempotency_key: req.body?.idempotency_key || `ai_call_${lead.id}_${req.body?.communication_id || Date.now()}`
      }])
      .select()
      .single();
    if (error) throw error;
    res.status(status === 'QUEUED' ? 202 : 200).json({ status: 'success', data: { analysis: data } });
  } catch (error) { next(error); }
});

router.post('/ai-analyses/:analysisId/flag', async (req, res, next) => {
  try {
    if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) {
      throw new AppError('Отметка ошибок ИИ доступна только руководителю или администратору', 403);
    }
    const db = getSafeDB();
    const { data, error } = await db
      .from('call_ai_analyses')
      .update({
        flagged_incorrect: true,
        flagged_reason: req.body?.reason || 'Отмечено руководителем',
        flagged_by: req.user.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.analysisId)
      .select()
      .single();
    if (error) throw error;
    res.json({ status: 'success', data: { analysis: data } });
  } catch (error) { next(error); }
});

router.post('/ai-analyses/:analysisId/confirm-task', async (req, res, next) => {
  try {
    const db = getSafeDB();
    const { data: analysis, error } = await db
      .from('call_ai_analyses')
      .select('*')
      .eq('id', req.params.analysisId)
      .single();
    if (error || !analysis) throw new AppError('Анализ не найден', 404);
    if (analysis.confirmed_task_id) {
      return res.json({ status: 'success', data: { analysis, alreadyConfirmed: true } });
    }
    const lead = await LeadsRepository.findById(analysis.lead_id);
    if (!lead) throw new AppError('Лид не найден', 404);
    if (!privileged(req.user) && String(lead.responsible_user_id) !== String(req.user.id)) {
      throw new AppError('Нет доступа к подтверждению задачи по этому лиду', 403);
    }
    const task = await TasksRepository.create({
      lead_id: lead.id,
      assigned_user_id: lead.responsible_user_id || req.user.id,
      created_by: req.user.id,
      type: req.body?.type || 'CALL',
      title: req.body?.title || analysis.suggested_next_step_json?.title || `Следующий шаг по ИИ-анализу: ${lead.full_name}`,
      due_at: req.body?.due_at || new Date(Date.now() + 2 * 3600000).toISOString(),
      due_date_only: false,
      timezone: 'Asia/Dushanbe',
      rule_key: 'AI_CONFIRMED_STEP',
      idempotency_key: `ai_task_${analysis.id}`
    });
    await db.from('call_ai_analyses').update({ confirmed_task_id: task.id }).eq('id', analysis.id);
    res.status(201).json({ status: 'success', data: { task, analysisId: analysis.id } });
  } catch (error) { next(error); }
});

export default router;
