import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../../app.js';
import * as dbConn from '../../../db/connection.js';
import { UsersRepository } from '../../users/users.repository.js';

describe('SMS API Routes (/api/sms)', () => {
  let adminToken;
  let managerToken;

  beforeEach(() => {
    vi.spyOn(UsersRepository, 'findById').mockImplementation(async (id) => {
      return {
        id: Number(id),
        name: 'Admin User',
        email: 'admin@tozon.tj',
        role: 'ADMIN',
        is_active: 1,
        permissions: ['*']
      };
    });

    const queryBuilder = {
      is: () => queryBuilder,
      eq: () => queryBuilder,
      order: () => Promise.resolve({ data: [], error: null }),
      single: () => Promise.resolve({ data: { id: 1, name: 'Admin User', role: 'ADMIN', is_active: 1 }, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve) => resolve({ data: [], error: null })
    };

    const mockSupabase = {
      from: (table) => ({
        select: () => queryBuilder,
        insert: (dataArr) => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 99, ...dataArr[0] }, error: null })
          })
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: 99 }, error: null })
            })
          })
        })
      })
    };

    vi.spyOn(dbConn, 'getDB').mockReturnValue(mockSupabase);
    vi.spyOn(dbConn, 'getServiceDB').mockReturnValue(mockSupabase);

    const secret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';
    adminToken = jwt.sign({ id: 1, role: 'ADMIN' }, secret);
    managerToken = jwt.sign({ id: 2, role: 'MANAGER' }, secret);
  });

  it('should reject unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post('/api/sms/send')
      .send({ phone: '+992927779757', text: 'Привет' });

    expect(res.status).toBe(401);
  });

  it('should reject requests with invalid phone number', async () => {
    const res = await request(app)
      .post('/api/sms/send')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '123', text: 'Привет' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBeDefined();
  });

  it('should reject requests with empty text', async () => {
    const res = await request(app)
      .post('/api/sms/send')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '+992927779757', text: '' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBeDefined();
  });

  it('should successfully dispatch SMS in mock environment for authorized user', async () => {
    const res = await request(app)
      .post('/api/sms/send')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '+992927779757', text: 'Уважаемый клиент, добро пожаловать в Tozon!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.phone).toBe('+992927779757');
    expect(res.body.data.senderName).toBe('TOZON-PLAZA');
  });

  it('should return history list for authenticated user', async () => {
    const res = await request(app)
      .get('/api/sms/history')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('should return template list for authenticated user', async () => {
    const res = await request(app)
      .get('/api/sms/templates')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('should include clientId when dispatching SMS for a client', async () => {
    const res = await request(app)
      .post('/api/sms/send')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        clientId: 42,
        phone: '+992927779757',
        text: 'Уважаемый клиент, Ваша бронь создана.'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.clientId).toBe(42);
  });

  it('should filter history by clientId when provided in query parameters', async () => {
    const res = await request(app)
      .get('/api/sms/history?clientId=42')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('should reject access if user lacks permission', async () => {
    vi.spyOn(UsersRepository, 'findById').mockResolvedValueOnce({
      id: 99,
      name: 'Unauthorized User',
      role: 'GUEST',
      is_active: 1,
      permissions: []
    });

    const secret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';
    const guestToken = jwt.sign({ id: 99, role: 'GUEST' }, secret);

    const res = await request(app)
      .post('/api/sms/send')
      .set('Authorization', `Bearer ${guestToken}`)
      .send({ phone: '+992927779757', text: 'Привет' });

    expect(res.status).toBe(403);
  });
});
