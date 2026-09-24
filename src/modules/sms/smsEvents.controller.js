import { defaultSmsEventsService } from './smsEvents.service.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export async function listEvents(req, res, next) {
  try {
    const filters = {
      status: req.query.status,
      eventType: req.query.eventType,
      clientId: req.query.clientId,
      dealId: req.query.dealId,
      page: req.query.page,
      limit: req.query.limit
    };

    const result = await defaultSmsEventsService.listEvents(filters);

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (err) {
    next(err);
  }
}

export async function getEventById(req, res, next) {
  try {
    const { id } = req.params;
    const event = await defaultSmsEventsService.getEventById(id);

    return res.status(200).json({
      success: true,
      data: event
    });
  } catch (err) {
    next(err);
  }
}

export async function previewEvent(req, res, next) {
  try {
    const { id } = req.params;
    const previewData = await defaultSmsEventsService.previewEvent(id);

    return res.status(200).json({
      success: true,
      data: previewData
    });
  } catch (err) {
    next(err);
  }
}

export async function cancelEvent(req, res, next) {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const userId = req.user?.id;

    const updatedEvent = await defaultSmsEventsService.cancelEvent({
      id,
      userId,
      reason
    });

    return res.status(200).json({
      success: true,
      message: 'Событие SMS Outbox успешно отменено',
      data: updatedEvent
    });
  } catch (err) {
    next(err);
  }
}

export async function confirmEvent(req, res, next) {
  try {
    const { id } = req.params;
    const { previewHash } = req.body || {};
    const userId = req.user?.id;

    const confirmResult = await defaultSmsEventsService.confirmEvent({
      id,
      userId,
      previewHash
    });

    return res.status(200).json({
      success: true,
      message: 'Событие SMS Outbox успешно обработано',
      data: confirmResult.event
    });
  } catch (err) {
    next(err);
  }
}
