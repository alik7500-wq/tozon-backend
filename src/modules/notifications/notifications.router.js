import { Router } from 'express';
import { protect } from '../../middleware/auth.middleware.js';
import { NotificationsService } from './notifications.service.js';

const router = Router();

// Protect all notification endpoints with authentication middleware
router.use(protect);

// GET /api/notifications — List notifications for current user
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const notifications = await NotificationsService.getUserNotifications(userId, req.query);
    res.json({ success: true, data: notifications });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/unread-count — Get unread notifications count for current user
router.get('/unread-count', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const count = await NotificationsService.getUnreadCount(userId);
    res.json({ success: true, count });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/stats — Get aggregated notification counts across categories for current user
router.get('/stats', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const stats = await NotificationsService.getNotificationStats(userId);
    res.json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read — Mark single notification as read for current user
router.patch('/:id/read', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const notificationId = Number(req.params.id);
    const updated = await NotificationsService.markAsRead(notificationId, userId);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/read-all — Mark all unread notifications as read for current user
router.post('/read-all', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const updatedList = await NotificationsService.markAllAsRead(userId);
    res.json({ success: true, count: updatedList.length });
  } catch (err) {
    next(err);
  }
});

export default router;
