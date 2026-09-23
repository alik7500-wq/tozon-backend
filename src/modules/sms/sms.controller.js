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

    const history = await defaultSmsService.getHistory(filters, req.user);

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

export async function previewSms(req, res, next) {
  try {
    const { templateCode, text, clientId, dealId, taskId, meetingId } = req.body;

    const previewResult = await defaultSmsService.previewSms({
      templateCode,
      text,
      clientId,
      dealId,
      taskId: taskId || meetingId
    });

    return res.status(200).json({
      success: true,
      data: previewResult
    });
  } catch (err) {
    next(err);
  }
}
