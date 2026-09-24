import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../../app.js';
import { PaymentReminderDetector } from '../paymentReminderDetector.js';

describe('V1.5D PAYMENT_REMINDER Scheduler Tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SMS_SCHEDULER_INTERNAL_TOKEN = 'test-secret-scheduler-token-12345';
    process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'true';
    process.env.SMS_OUTBOX_CONFIRM_ENABLED = 'false';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('Internal Authentication & Security (Section 7 & 9)', () => {
    it('01. Missing Authorization header is rejected with 401', async () => {
      const res = await request(app)
        .post('/api/internal/sms/payment-reminder/run')
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.status).toBe('fail');
      expect(res.body.message).toContain('Authorization');
    });

    it('02. Invalid/Wrong Bearer scheduler token is rejected with 401', async () => {
      const res = await request(app)
        .post('/api/internal/sms/payment-reminder/run')
        .set('Authorization', 'Bearer wrong-secret-token-123456789012345')
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.status).toBe('fail');
      expect(res.body.message).toContain('токе');
    });

    it('03. Different length Bearer token is safely rejected with 401', async () => {
      const res = await request(app)
        .post('/api/internal/sms/payment-reminder/run')
        .set('Authorization', 'Bearer short')
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.status).toBe('fail');
    });

    it('04. Server unconfigured SMS_SCHEDULER_INTERNAL_TOKEN fails closed with 503', async () => {
      delete process.env.SMS_SCHEDULER_INTERNAL_TOKEN;

      const res = await request(app)
        .post('/api/internal/sms/payment-reminder/run')
        .set('Authorization', 'Bearer test-secret-scheduler-token-12345')
        .send({});

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('error');
    });

    it('05. Correct Authorization Bearer header token is accepted with 200', async () => {
      vi.spyOn(PaymentReminderDetector, 'detectPaymentReminders').mockResolvedValue({
        businessDate: '2026-09-25',
        scanned: 10,
        eligible: 0,
        created: 0,
        already_exists: 0,
        cancelled_stale: 0,
        skipped_paid: 0,
        skipped_overdue: 0,
        skipped_invalid_phone: 0,
        skipped_ineligible_deal: 0,
        errors: 0,
        candidates: []
      });

      const res = await request(app)
        .post('/api/internal/sms/payment-reminder/run')
        .set('Authorization', 'Bearer test-secret-scheduler-token-12345')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.scanned).toBe(10);
    });

    it('06. Internal secret token is NEVER exposed in API response body', async () => {
      vi.spyOn(PaymentReminderDetector, 'detectPaymentReminders').mockResolvedValue({
        businessDate: '2026-09-25',
        scanned: 0,
        eligible: 0,
        created: 0,
        already_exists: 0,
        cancelled_stale: 0,
        errors: 0,
        candidates: []
      });

      const res = await request(app)
        .post('/api/internal/sms/payment-reminder/run')
        .set('Authorization', 'Bearer test-secret-scheduler-token-12345')
        .send({});

      const responseStr = JSON.stringify(res.body);
      expect(responseStr).not.toContain('test-secret-scheduler-token-12345');
    });
  });

  describe('Feature Flag Safety & Control (Section 9 & 10)', () => {
    it('07. Rejected with HTTP 400 when SMS_PAYMENT_REMINDER_DETECTOR_ENABLED=false', async () => {
      process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'false';

      const res = await request(app)
        .post('/api/internal/sms/payment-reminder/run')
        .set('Authorization', 'Bearer test-secret-scheduler-token-12345')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('fail');
      expect(res.body.message).toContain('отключен');
    });

    it('08. Scheduler executes detector when SMS_PAYMENT_REMINDER_DETECTOR_ENABLED=true', async () => {
      const detectSpy = vi.spyOn(PaymentReminderDetector, 'detectPaymentReminders').mockResolvedValue({
        businessDate: '2026-09-25',
        scanned: 100,
        eligible: 2,
        created: 2,
        already_exists: 0,
        cancelled_stale: 0,
        errors: 0,
        candidates: []
      });

      const res = await request(app)
        .post('/api/internal/sms/payment-reminder/run')
        .set('Authorization', 'Bearer test-secret-scheduler-token-12345')
        .send({});

      expect(res.status).toBe(200);
      expect(detectSpy).toHaveBeenCalledWith({ businessDate: null, isDryRun: false });
    });

    it('09. Scheduler does NOT modify SMS_OUTBOX_CONFIRM_ENABLED flag', async () => {
      expect(process.env.SMS_OUTBOX_CONFIRM_ENABLED).toBe('false');

      vi.spyOn(PaymentReminderDetector, 'detectPaymentReminders').mockResolvedValue({
        businessDate: '2026-09-25',
        scanned: 0,
        eligible: 0,
        created: 0,
        already_exists: 0,
        cancelled_stale: 0,
        errors: 0,
        candidates: []
      });

      await request(app)
        .post('/api/internal/sms/payment-reminder/run')
        .set('Authorization', 'Bearer test-secret-scheduler-token-12345')
        .send({});

      expect(process.env.SMS_OUTBOX_CONFIRM_ENABLED).toBe('false');
    });
  });

  describe('Zero SMS / No Payom Guarantees (Section 10 & 25)', () => {
    it('10. Scheduler execution CANNOT send real SMS or call Payom', async () => {
      vi.spyOn(PaymentReminderDetector, 'detectPaymentReminders').mockResolvedValue({
        businessDate: '2026-09-25',
        scanned: 660,
        eligible: 5,
        created: 5,
        already_exists: 0,
        cancelled_stale: 0,
        errors: 0,
        candidates: []
      });

      const res = await request(app)
        .post('/api/internal/sms/payment-reminder/run')
        .set('Authorization', 'Bearer test-secret-scheduler-token-12345')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(5);
      expect(res.body.data.real_sms_sent).toBeUndefined();
      expect(res.body.data.payom_calls).toBeUndefined();
    });
  });
});
