import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { settings, identity, history, phone, request } from './moizvonki.js';
const mocks = vi.hoisted(() => ({ user: { id: 2, role: 'MANAGER', permissions: ['leads.manage'] }, find: vi.fn() }));
vi.mock('../../middleware/auth.middleware.js', () => ({ protect: (req,res,next) => { req.user = mocks.user; next(); } }));
vi.mock('../leads/leads.repository.js', () => ({ LeadsRepository: { findById: mocks.find } }));
import router from './calls.router.js';
const config = { url: 'https://demo.moizvonki.ru/api/v1', key: 'test-key', mapping: { '2': 'manager@example.com' }, admin: 'admin@example.com' };
const response = data => ({ ok: true, json: async () => data });

describe('Мои Звонки', () => {
  it('normalizes local and international numbers without accepting arbitrary text', () => {
    expect(phone('92 123 45 67')).toBe('+992921234567');
    expect(phone('+7 (999) 123-45-67')).toBe('+79991234567');
    expect(phone('abc921234567')).toBeNull();
  });
  it('fails closed when disabled or given a foreign API host', () => {
    expect(() => settings({})).toThrow();
    expect(() => settings({ MOIZVONKI_ENABLED:'true', MOIZVONKI_API_URL:'https://attacker.test', MOIZVONKI_API_KEY:'x' })).toThrow();
    expect(() => settings({ MOIZVONKI_ENABLED:'true', MOIZVONKI_API_URL:'https://demo.moizvonki.ru@attacker.test', MOIZVONKI_API_KEY:'x' })).toThrow();
  });
  it('never uses administrator phone as fallback for dialing', () => {
    expect(() => identity({id:9, role:'ADMIN'}, config)).toThrow();
    expect(identity({id:2, role:'ADMIN'}, config).email).toBe('manager@example.com');
    expect(identity({id:9, role:'ADMIN'}, config, true).supervised).toBe(1);
  });
  it('paginates, deduplicates and filters both client numbers', async () => {
    const call = {db_call_id:1,client_number:'921234567',direction:0,answered:0,start_time:100,recording:'javascript:alert(1)'};
    const fetcher = vi.fn().mockResolvedValueOnce(response({results:[call,{...call,db_call_id:3,client_number:'+79991234567'}],results_next_offset:100}))
      .mockResolvedValueOnce(response({results:[call,{...call,db_call_id:2,client_number:'+992931234567',answered:1}],results_next_offset:0}));
    const result = await history({id:2,role:'MANAGER'},['+992921234567','931234567'],{config,fetcher});
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].recording).toBeNull();
    const body=JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.from_offset).toBe(100); expect(body.supervised).toBe(0);
  });
  it('rejects malformed provider pagination and hides provider errors', async () => {
    await expect(history({id:2,role:'MANAGER'},['921234567'],{config,fetcher:async()=>response({results:[],results_next_offset:-1})})).rejects.toThrow('пагинация');
    await expect(request(config,'m@example.com','calls.make_call',{},async()=>({ok:false}))).rejects.toThrow('отклонили');
  });
  it('does not automatically retry a dial timeout', async () => {
    const fetcher=vi.fn().mockRejectedValue(new Error('secret upstream failure'));
    await expect(request(config,'m@example.com','calls.make_call',{},fetcher)).rejects.toThrow('повторный звонок');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('denies history and dialing for another manager’s client before contacting provider', async () => {
    mocks.find.mockResolvedValue({id:1,responsible_user_id:3,phone:'921234567'});
    const app=express(); app.use(express.json()); app.use(router);
    app.use((err,req,res,next)=>res.status(err.statusCode || 500).json({message:err.message}));
    expect((await supertest(app).get('/leads/1')).status).toBe(403);
    expect((await supertest(app).post('/leads/1/dial').send({})).status).toBe(403);
  });
});
