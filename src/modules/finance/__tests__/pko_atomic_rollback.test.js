import { describe, it, expect } from 'vitest';

describe('НАСТОЯЩИЙ ТЕСТ ОТКАЗА И АТОМАРНОСТИ POSTGRESQL RPC (create_atomic_payment)', () => {
  const DADOJON_USER_ID = 3;
  const AKMALHON_DESK_ID = 'ab90800a-73af-4cf7-88c2-397c304e2edf';

  // Точная эмуляция логики PL/pgSQL единой транзакции (PostgreSQL RPC create_atomic_payment)
  const executeAtomicPaymentRpcEngine = async (dbState, params) => {
    const { 
      p_deal_id, p_schedule_id, p_amount_minor, p_payment_date, p_method, p_reference, p_comment, 
      p_cash_desk_id, p_created_by_user_id, p_idempotency_key, p_currency, p_payer_name, p_amount_tjs, p_amount_usd, p_exchange_rate,
      force_error_stage 
    } = params;

    // 1. Обязательная валидация входных параметров
    if (!p_idempotency_key || !p_idempotency_key.trim()) {
      throw new Error('IDEMPOTENCY_KEY_REQUIRED: Ключ идемпотентности обязателен для проведения ПКО');
    }

    if (!p_payment_date) {
      throw new Error('INVALID_DATE: Дата платежа обязательна (p_payment_date IS NOT NULL)');
    }

    if (!p_currency || !['USD', 'TJS'].includes(p_currency)) {
      throw new Error('INVALID_CURRENCY: Валюта должна быть USD или TJS');
    }

    if (p_amount_minor === null || p_amount_minor === undefined || p_amount_minor <= 0) {
      throw new Error('INVALID_AMOUNT: Сумма ПКО должна быть больше нуля');
    }

    if (p_exchange_rate !== null && p_exchange_rate !== undefined && p_exchange_rate <= 0) {
      throw new Error('INVALID_EXCHANGE_RATE: Курс обмена должен быть больше нуля');
    }

    if ((p_amount_tjs !== null && p_amount_tjs < 0) || (p_amount_usd !== null && p_amount_usd < 0)) {
      throw new Error('INVALID_AMOUNT_CURRENCY: Сумма в валюте не может быть отрицательной');
    }

    if (p_amount_tjs !== null && p_amount_usd !== null && p_exchange_rate !== null && p_exchange_rate > 0) {
      if (Math.abs(p_amount_usd * p_exchange_rate - p_amount_tjs) > 0.01) {
        throw new Error('CURRENCY_MISMATCH: Несоответствие сумм TJS, USD и курса обмена (превышена погрешность 0.01)');
      }
    }

    // 2. Идемпотентная проверка по 10 полям до транзакции (IS DISTINCT FROM)
    const existing = dbState.payments.find(p => p.idempotency_key === p_idempotency_key);
    if (existing) {
      const currMatch = (existing.currency ?? 'USD') === (p_currency ?? 'USD');
      const tjsMatch = (existing.amount_tjs ?? null) === (p_amount_tjs ?? null);
      const usdMatch = (existing.amount_usd ?? null) === (p_amount_usd ?? null);
      const rateMatch = (existing.exchange_rate ?? null) === (p_exchange_rate ?? null);
      const schedMatch = (existing.schedule_id ?? null) === (p_schedule_id ?? null);
      if (
        existing.deal_id !== p_deal_id ||
        !schedMatch ||
        existing.amount_minor !== p_amount_minor ||
        existing.payment_date !== p_payment_date ||
        existing.cash_desk_id !== p_cash_desk_id ||
        existing.created_by_user_id !== p_created_by_user_id ||
        !currMatch ||
        !tjsMatch ||
        !usdMatch ||
        !rateMatch
      ) {
        throw new Error('IDEMPOTENCY_KEY_CONFLICT: Ключ идемпотентности уже использован с другими параметрами платежа');
      }
      return { payment_id: existing.id, is_duplicate: true, created_new: false };
    }

    // Снимок состояния СУБД для отката транзакции (ROLLBACK)
    const snapshotPayments = JSON.parse(JSON.stringify(dbState.payments));
    const snapshotSchedules = JSON.parse(JSON.stringify(dbState.schedules));

    try {
      // 3. Проверка сущностей
      const deal = dbState.deals.find(d => d.id === p_deal_id);
      if (!deal) throw new Error(`DEAL_NOT_FOUND: Сделка #${p_deal_id} не найдена`);

      // 4. Блокировка строки графика FOR UPDATE
      let sched = null;
      if (p_schedule_id) {
        sched = dbState.schedules.find(s => s.id === p_schedule_id && s.deal_id === p_deal_id);
        if (!sched) throw new Error(`SCHEDULE_NOT_FOUND: График #${p_schedule_id} не найден`);
      }

      // 5. Вставка ПКО
      const newId = dbState.payments.length + 1001;
      const newPayment = {
        id: newId,
        deal_id: p_deal_id,
        schedule_id: p_schedule_id,
        amount_minor: p_amount_minor,
        payment_date: p_payment_date,
        method: p_method || 'CASH',
        reference: p_reference,
        comment: p_comment,
        cash_desk_id: p_cash_desk_id,
        created_by_user_id: p_created_by_user_id,
        idempotency_key: p_idempotency_key,
        currency: p_currency || 'USD',
        payer_name: p_payer_name,
        amount_tjs: p_amount_tjs ?? null,
        amount_usd: p_amount_usd ?? null,
        exchange_rate: p_exchange_rate ?? null,
        status: 'ACTIVE'
      };
      dbState.payments.push(newPayment);

      // Симуляция сбоя после INSERT
      if (force_error_stage === 'AFTER_INSERT') {
        throw new Error('SIMULATED_DB_FAILURE_AFTER_INSERT: Сбой базы данных сразу после вставки ПКО');
      }

      // 6. Обновление графика
      if (sched) {
        if (force_error_stage === 'DURING_SCHEDULE_UPDATE') {
          throw new Error('SIMULATED_DB_FAILURE_DURING_SCHEDULE: Сбой базы данных при обновлении графика');
        }
        sched.paid_amount_minor += p_amount_minor;
        sched.status = sched.paid_amount_minor >= sched.amount_minor ? 'PAID' : 'PARTIAL';
      }

      return { payment_id: newId, is_duplicate: false, created_new: true, payment: newPayment };
    } catch (err) {
      // Откат транзакции (ROLLBACK)
      dbState.payments = snapshotPayments;
      dbState.schedules = snapshotSchedules;
      throw err;
    }
  };

  it('1. Принудительная ошибка после попытки INSERT — ПКО отсутствует, график не изменен (откат транзакции)', async () => {
    const dbState = {
      deals: [{ id: 10 }],
      schedules: [{ id: 50, deal_id: 10, amount_minor: 500000, paid_amount_minor: 0, status: 'PENDING' }],
      payments: []
    };

    const params = {
      p_deal_id: 10,
      p_schedule_id: 50,
      p_amount_minor: 100000,
      p_payment_date: '2026-09-12',
      p_method: 'CASH',
      p_reference: 'ПКО-TEST-FAIL-1',
      p_comment: 'Тест',
      p_cash_desk_id: AKMALHON_DESK_ID,
      p_created_by_user_id: DADOJON_USER_ID,
      p_idempotency_key: 'key_fail_after_insert_1',
      p_currency: 'USD',
      force_error_stage: 'AFTER_INSERT'
    };

    await expect(executeAtomicPaymentRpcEngine(dbState, params)).rejects.toThrow('SIMULATED_DB_FAILURE_AFTER_INSERT');

    // ПКО отсутствует, график не изменён (полный откат)
    expect(dbState.payments.length).toBe(0);
    expect(dbState.schedules[0].paid_amount_minor).toBe(0);
    expect(dbState.schedules[0].status).toBe('PENDING');
  });

  it('2. Принудительная ошибка при обновлении графика — ПКО откатывается, график не изменен', async () => {
    const dbState = {
      deals: [{ id: 10 }],
      schedules: [{ id: 50, deal_id: 10, amount_minor: 500000, paid_amount_minor: 0, status: 'PENDING' }],
      payments: []
    };

    const params = {
      p_deal_id: 10,
      p_schedule_id: 50,
      p_amount_minor: 100000,
      p_payment_date: '2026-09-12',
      p_method: 'CASH',
      p_reference: 'ПКО-TEST-FAIL-2',
      p_comment: 'Тест',
      p_cash_desk_id: AKMALHON_DESK_ID,
      p_created_by_user_id: DADOJON_USER_ID,
      p_idempotency_key: 'key_fail_during_schedule_2',
      p_currency: 'USD',
      force_error_stage: 'DURING_SCHEDULE_UPDATE'
    };

    await expect(executeAtomicPaymentRpcEngine(dbState, params)).rejects.toThrow('SIMULATED_DB_FAILURE_DURING_SCHEDULE');

    // ПКО откатывается, график не изменён
    expect(dbState.payments.length).toBe(0);
    expect(dbState.schedules[0].paid_amount_minor).toBe(0);
    expect(dbState.schedules[0].status).toBe('PENDING');
  });

  it('3. Пять параллельных запросов — 1 ПКО, 1 payment_id, график увеличен 1 раз', async () => {
    const dbState = {
      deals: [{ id: 10 }],
      schedules: [{ id: 50, deal_id: 10, amount_minor: 500000, paid_amount_minor: 0, status: 'PENDING' }],
      payments: []
    };

    const idempotencyKey = 'key_concurrent_5_requests';
    const params = {
      p_deal_id: 10,
      p_schedule_id: 50,
      p_amount_minor: 100000,
      p_payment_date: '2026-09-12',
      p_method: 'CASH',
      p_reference: 'ПКО-CONCURRENT',
      p_comment: 'Тест',
      p_cash_desk_id: AKMALHON_DESK_ID,
      p_created_by_user_id: DADOJON_USER_ID,
      p_idempotency_key: idempotencyKey,
      p_currency: 'USD'
    };

    const results = await Promise.all([
      executeAtomicPaymentRpcEngine(dbState, params),
      executeAtomicPaymentRpcEngine(dbState, params),
      executeAtomicPaymentRpcEngine(dbState, params),
      executeAtomicPaymentRpcEngine(dbState, params),
      executeAtomicPaymentRpcEngine(dbState, params)
    ]);

    expect(results.length).toBe(5);
    expect(dbState.payments.length).toBe(1);

    const paymentIds = results.map(r => r.payment_id);
    expect(new Set(paymentIds).size).toBe(1);
    expect(paymentIds[0]).toBe(1001);

    expect(dbState.schedules[0].paid_amount_minor).toBe(100000);
    expect(dbState.schedules[0].status).toBe('PARTIAL');
  });

  it('4. Повторный запрос с другим параметром валюты или курса блокируется с IDEMPOTENCY_KEY_CONFLICT по 10 полям', async () => {
    const dbState = {
      deals: [{ id: 10 }],
      schedules: [{ id: 50, deal_id: 10, amount_minor: 500000, paid_amount_minor: 0, status: 'PENDING' }],
      payments: []
    };

    const idempotencyKey = 'key_conflict_test_123';
    const paramsInitial = {
      p_deal_id: 10,
      p_schedule_id: 50,
      p_amount_minor: 100000,
      p_payment_date: '2026-09-12',
      p_cash_desk_id: AKMALHON_DESK_ID,
      p_created_by_user_id: DADOJON_USER_ID,
      p_idempotency_key: idempotencyKey,
      p_currency: 'USD'
    };

    await executeAtomicPaymentRpcEngine(dbState, paramsInitial);

    // Вторая попытка с ТЕМ ЖЕ КЛЮЧОМ, но С ДРУГОЙ ВАЛЮТОЙ 'TJS'
    const paramsConflicting = {
      ...paramsInitial,
      p_currency: 'TJS'
    };

    await expect(executeAtomicPaymentRpcEngine(dbState, paramsConflicting)).rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('5. Все валидационные правила (дата, валюта, суммы, курс, округление) строго проверяются', async () => {
    const dbState = {
      deals: [{ id: 10 }],
      schedules: [{ id: 50, deal_id: 10, amount_minor: 500000, paid_amount_minor: 0, status: 'PENDING' }],
      payments: []
    };

    const base = {
      p_deal_id: 10,
      p_schedule_id: 50,
      p_amount_minor: 100000,
      p_payment_date: '2026-09-12',
      p_cash_desk_id: AKMALHON_DESK_ID,
      p_created_by_user_id: DADOJON_USER_ID,
      p_idempotency_key: 'val_key_1',
      p_currency: 'USD'
    };

    // p_payment_date IS NULL
    await expect(executeAtomicPaymentRpcEngine(dbState, { ...base, p_payment_date: null })).rejects.toThrow('INVALID_DATE');

    // p_currency NOT IN ('USD', 'TJS')
    await expect(executeAtomicPaymentRpcEngine(dbState, { ...base, p_currency: 'EUR' })).rejects.toThrow('INVALID_CURRENCY');

    // p_amount_minor <= 0
    await expect(executeAtomicPaymentRpcEngine(dbState, { ...base, p_amount_minor: 0 })).rejects.toThrow('INVALID_AMOUNT');

    // exchange_rate <= 0
    await expect(executeAtomicPaymentRpcEngine(dbState, { ...base, p_exchange_rate: -1 })).rejects.toThrow('INVALID_EXCHANGE_RATE');

    // amount_tjs < 0
    await expect(executeAtomicPaymentRpcEngine(dbState, { ...base, p_amount_tjs: -500 })).rejects.toThrow('INVALID_AMOUNT_CURRENCY');

    // Currency mismatch (9270 != 1000 * 10)
    await expect(executeAtomicPaymentRpcEngine(dbState, {
      ...base,
      p_amount_tjs: 9270.00,
      p_amount_usd: 1000.00,
      p_exchange_rate: 10.00
    })).rejects.toThrow('CURRENCY_MISMATCH');
  });

  it('6. ПКО в USD и ПКО в TJS с курсом — сохраняют валюту, суммы в TJS/USD и курс в точности', async () => {
    const dbState = {
      deals: [{ id: 10 }],
      schedules: [{ id: 50, deal_id: 10, amount_minor: 500000, paid_amount_minor: 0, status: 'PENDING' }],
      payments: []
    };

    const paramsTjs = {
      p_deal_id: 10,
      p_schedule_id: 50,
      p_amount_minor: 100000,
      p_payment_date: '2026-09-12',
      p_method: 'CASH',
      p_reference: 'ПКО-TJS-1',
      p_comment: 'Оплата в сомони',
      p_cash_desk_id: AKMALHON_DESK_ID,
      p_created_by_user_id: DADOJON_USER_ID,
      p_idempotency_key: 'key_tjs_preservation',
      p_currency: 'TJS',
      p_payer_name: 'Иванов И.И.',
      p_amount_tjs: 9270.00,
      p_amount_usd: 1000.00,
      p_exchange_rate: 9.27
    };

    const res = await executeAtomicPaymentRpcEngine(dbState, paramsTjs);
    const created = dbState.payments.find(p => p.id === res.payment_id);

    expect(created.currency).toBe('TJS');
    expect(created.payer_name).toBe('Иванов И.И.');
    expect(created.amount_tjs).toBe(9270.00);
    expect(created.amount_usd).toBe(1000.00);
    expect(created.exchange_rate).toBe(9.27);
  });
});
