import { defaultSmsService } from './sms.service.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export async function sendSms(req, res, next) {
  try {
    const { clientId, phone, text, templateCode, dealId, contractId } = req.body;
    const userId = req.user?.id;

    if (!clientId && !phone) {
      throw new AppError('Укажите clientId или телефон получателя', 400);
    }

    if (!text || !text.trim()) {
      throw new AppError('Текст сообщения обязателен', 400);
    }

    const result = await defaultSmsService.sendSms({
      clientId,
      phone,
      text,
      templateCode,
      dealId,
      contractId,
      userId,
      senderName: 'TOZON-PLAZA'
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || {
          code: 'SMS_DISPATCH_FAILED',
          message: 'Ошибка при отправке SMS через провайдер Payom'
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: 'SMS успешно отправлено',
      data: result.data
    });
  } catch (err) {
    next(err);
  }
}

export async function getHistory(req, res, next) {
  try {
    const filters = {
      clientId: req.query.clientId,
      status: req.query.status
    };

    const history = await defaultSmsService.getHistory(filters);

    return res.status(200).json({
      success: true,
      data: history
    });
  } catch (err) {
    next(err);
  }
}

export async function getTemplates(req, res, next) {
  try {
    const templates = await defaultSmsService.getTemplates();

    return res.status(200).json({
      success: true,
      data: templates
    });
  } catch (err) {
    next(err);
  }
}

export async function testDbWrite(req, res, next) {
  try {
    const { SmsRepository } = await import('./sms.repository.js');
    const { getServiceDB } = await import('../../db/connection.js');
    const userId = req.user?.id;

    // 1. Create record directly via SmsRepository (getServiceDB) WITHOUT calling Payom
    const record = await SmsRepository.createMessage({
      phone: '+992927797576',
      message: 'DB WRITE GATE TEST - NO SMS',
      provider: 'PAYOM',
      senderName: 'TOZON-PLAZA',
      status: 'queued',
      createdBy: userId
    });

    if (!record || !record.id) {
      throw new AppError('Failed to create DB test record', 500);
    }

    const isRealDbId = typeof record.id === 'number' && record.id < 1000000000000;

    // 2. Select back via getServiceDB
    const db = getServiceDB();
    const { data: fetchedRecord, error: selectErr } = await db
      .from('sms_messages')
      .select('*')
      .eq('id', record.id)
      .single();

    // 3. Delete test record
    const { error: deleteErr } = await db
      .from('sms_messages')
      .delete()
      .eq('id', record.id);

    return res.status(200).json({
      success: true,
      message: 'DB Write Gate Test Succeeded',
      data: {
        recordId: record.id,
        isRealDbId,
        selectSuccess: !selectErr && Boolean(fetchedRecord),
        deleteSuccess: !deleteErr,
        fetchedRecord
      }
    });
  } catch (err) {
    next(err);
  }
}
