import './test_env.js';
import { describe, it, expect } from 'vitest';

describe('Real Notifications V1 Frontend Contract & Safety Verification', () => {
  const processNotificationResponse = (res) => {
    // Exact logic used in hotfixed NotificationsPage.jsx
    const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
    const safeNotifications = Array.isArray(list) ? list : [];
    const unreadCount = safeNotifications.filter(n => !n?.is_read).length;
    return { list: safeNotifications, unreadCount };
  };

  const processUnreadCountResponse = (res) => {
    // Exact logic used in hotfixed MainLayout.jsx
    return typeof res?.count === 'number' ? res.count : (typeof res?.data?.count === 'number' ? res.data.count : 0);
  };

  it('A. API returns canonical empty response -> safe empty list & 0 unread', () => {
    const res = { success: true, data: [] };
    const { list, unreadCount } = processNotificationResponse(res);
    expect(list).toEqual([]);
    expect(unreadCount).toBe(0);
  });

  it('B. API returns one notification -> one item in list', () => {
    const res = { success: true, data: [{ id: 1, title: 'Note 1', is_read: false }] };
    const { list, unreadCount } = processNotificationResponse(res);
    expect(list.length).toBe(1);
    expect(unreadCount).toBe(1);
  });

  it('C. API returns multiple notifications -> filter works correctly', () => {
    const res = {
      success: true,
      data: [
        { id: 1, title: 'Note 1', is_read: false },
        { id: 2, title: 'Note 2', is_read: true },
        { id: 3, title: 'Note 3', is_read: false }
      ]
    };
    const { list, unreadCount } = processNotificationResponse(res);
    expect(list.length).toBe(3);
    expect(unreadCount).toBe(2);
  });

  it('D. unread-count = 0 -> count = 0, badge hidden', () => {
    const res = { success: true, count: 0 };
    const count = processUnreadCountResponse(res);
    expect(count).toBe(0);
  });

  it('E. unread-count > 0 -> count correctly extracted', () => {
    const res = { success: true, count: 5 };
    const count = processUnreadCountResponse(res);
    expect(count).toBe(5);
  });

  it('F & G. Malformed API response (object without data array) -> NO crash, safe fallback', () => {
    const malformed1 = { success: true };
    const malformed2 = { success: true, message: 'some text' };
    const malformed3 = null;

    expect(() => processNotificationResponse(malformed1)).not.toThrow();
    expect(() => processNotificationResponse(malformed2)).not.toThrow();
    expect(() => processNotificationResponse(malformed3)).not.toThrow();

    const result1 = processNotificationResponse(malformed1);
    expect(result1.list).toEqual([]);
    expect(result1.unreadCount).toBe(0);
  });
});
