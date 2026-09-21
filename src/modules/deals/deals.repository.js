import { getDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class DealsRepository {
  static async findAll(filters = {}) {
    const db = getDB();
    
    let query = db.from('deals').select(`
      *,
      leads ( full_name, phone, passport_series, passport_number, inn ),
      units ( 
        unit_number, rooms, area_m2_x100, price_per_m2_minor,
        floors ( floor_number, name, sections ( name, buildings ( name, projects ( id, name, developer_name, currency ) ) ) )
      ),
      users!responsible_user_id ( name ),
      payments ( amount_minor ),
      deal_payment_schedules ( paid_amount_minor )
    `).order('created_at', { ascending: false });

    if (filters.status && filters.status !== 'ALL') {
      query = query.eq('status', filters.status);
    }
    if (filters.paymentType && filters.paymentType !== 'ALL') {
      query = query.eq('payment_type', filters.paymentType);
    }
    
    const { data, error } = await query;
    if (error) throw error;

    let deals = data;

    // We have to filter by project_id and search term manually since they are nested deeply
    if (filters.projectId && filters.projectId !== 'ALL') {
      deals = deals.filter(d => d.units?.floors?.sections?.buildings?.projects?.id == filters.projectId);
    }

    if (filters.search) {
      const s = filters.search.toLowerCase();
      deals = deals.filter(d => 
        (d.contract_number && d.contract_number.toLowerCase().includes(s)) ||
        (d.leads?.full_name && d.leads.full_name.toLowerCase().includes(s)) ||
        (d.leads?.phone && d.leads.phone.toLowerCase().includes(s)) ||
        (d.units?.unit_number && String(d.units.unit_number).toLowerCase().includes(s)) ||
        (d.units?.floors?.sections?.buildings?.projects?.name && d.units.floors.sections.buildings.projects.name.toLowerCase().includes(s))
      );
    }

    const today = new Date().toISOString().split('T')[0];

    return deals.map((deal) => {
      // Flatten the structure to match the old SQL return shape
      const p = deal.units?.floors?.sections?.buildings?.projects || {};
      
      const activePayments = deal.payments ? deal.payments.filter(pm => pm.status !== 'VOIDED') : [];
      const paidAmountMinor = activePayments.reduce((acc, pm) => acc + (pm.amount_minor || 0), 0);
      const remainingDebt = Math.max(0, (deal.final_price_minor || 0) - paidAmountMinor);
      const paidPercent = deal.final_price_minor > 0 ? Number(((paidAmountMinor / deal.final_price_minor) * 100).toFixed(2)) : 0;
      const isOverdue = deal.status === 'RESERVED' && deal.reservation_expires_at && deal.reservation_expires_at < today;

      const areaM2 = deal.units?.area_m2_x100 ? (deal.units.area_m2_x100 / 100) : 0;
      const computedDealPricePerM2 = deal.deal_price_per_m2_minor || (areaM2 > 0 ? Math.round(deal.final_price_minor / areaM2) : deal.units?.price_per_m2_minor);

      return {
        ...deal,
        lead_name: deal.leads?.full_name,
        lead_phone: deal.leads?.phone,
        passport_series: deal.leads?.passport_series,
        passport_number: deal.leads?.passport_number,
        inn: deal.leads?.inn,
        unit_number: deal.units?.unit_number,
        unit_rooms: deal.units?.rooms,
        area_m2_x100: deal.units?.area_m2_x100,
        deal_price_per_m2_minor: computedDealPricePerM2,
        unit_price_per_m2_minor: deal.units?.price_per_m2_minor,
        price_per_m2_minor: computedDealPricePerM2,
        exchange_rate: deal.exchange_rate || 9.29,
        floor_number: deal.units?.floors?.floor_number,
        floor_name: deal.units?.floors?.name,
        section_name: deal.units?.floors?.sections?.name,
        building_name: deal.units?.floors?.sections?.buildings?.name,
        project_id: p.id,
        project_name: p.name,
        developer_name: p.developer_name,
        project_currency: p.currency,
        manager_name: deal.users?.name,
        paid_amount_minor: paidAmountMinor,
        total_paid_minor: paidAmountMinor,
        remaining_debt_minor: remainingDebt,
        paid_percent: paidPercent,
        is_reservation_expired: !!isOverdue,
        // clean up nested objects to avoid confusion
        leads: undefined, units: undefined, users: undefined, payments: undefined, deal_payment_schedules: undefined
      };
    });
  }

  static async getStats() {
    const db = getDB();
    const { data: deals, error } = await db.from('deals').select('status, final_price_minor, payment_type');
    if (error) throw error;
    
    let total_deals = 0, signed_count = 0, total_signed_revenue_minor = 0;
    let reserved_count = 0, total_reserved_volume_minor = 0;
    let cancelled_count = 0, installment_plans_count = 0;

    deals.forEach(d => {
      total_deals++;
      if (d.status === 'SIGNED') {
        signed_count++;
        total_signed_revenue_minor += d.final_price_minor;
        if (d.payment_type === 'INSTALLMENT' || d.payment_type === 'PARTIAL_BARTER') {
          installment_plans_count++;
        }
      } else if (d.status === 'RESERVED') {
        reserved_count++;
        total_reserved_volume_minor += d.final_price_minor;
      } else if (d.status === 'CANCELLED') {
        cancelled_count++;
      }
    });

    const { data: pmts } = await db.from('payments').select('amount_minor, status, deal_id').not('deal_id', 'is', null).neq('status', 'VOIDED');
    const { data: scheds } = await db.from('deal_payment_schedules').select('paid_amount_minor');
    
    const paymentsSum = (pmts || []).reduce((acc, p) => acc + (p.amount_minor || 0), 0);
    const scheduleSum = (scheds || []).reduce((acc, s) => acc + (s.paid_amount_minor || 0), 0);
    
    const totalCollected = Math.max(paymentsSum, scheduleSum);
    const outstandingDebt = Math.max(0, total_signed_revenue_minor - totalCollected);

    return {
      total_deals,
      signed_count,
      total_signed_revenue_minor,
      reserved_count,
      total_reserved_volume_minor,
      cancelled_count,
      installment_plans_count,
      total_collected_minor: totalCollected,
      outstanding_debt_minor: outstandingDebt,
    };
  }

  static async getDealById(id) {
    const db = getDB();
    const { data: deal, error } = await db.from('deals').select(`
      *,
      leads ( full_name, phone, secondary_phone, passport_series, passport_number, passport_issued_by, passport_issue_date, birth_date, registration_address, inn ),
      units ( 
        unit_number, rooms, area_m2_x100, price_per_m2_minor, status,
        layout_types ( name, image_path ),
        floors ( floor_number, name, sections ( name, buildings ( name, projects ( id, name, developer_name, address, currency ) ) ) )
      ),
      users!responsible_user_id ( name, email ),
      payments ( *, users!created_by_user_id ( name ) ),
      deal_payment_schedules ( * )
    `).eq('id', id).single();
    
    if (error && error.code !== 'PGRST116') throw error;
    if (!deal) return null;

    const today = new Date().toISOString().split('T')[0];
    const p = deal.units?.floors?.sections?.buildings?.projects || {};

    // Process Schedules
    const rawSchedules = deal.deal_payment_schedules || [];
    rawSchedules.sort((a, b) => a.payment_number - b.payment_number);
    
    const schedules = rawSchedules.map((item) => {
      const paid = item.paid_amount_minor || 0;
      const planned = item.amount_minor || 0;
      const remaining = Math.max(0, planned - paid);

      let computedStatus = 'UPCOMING';
      if (remaining === 0) computedStatus = 'PAID';
      else if (paid > 0 && paid < planned) computedStatus = 'PARTIAL';
      else if (item.due_date < today) computedStatus = 'OVERDUE';
      else if (item.due_date === today) computedStatus = 'DUE';

      return { ...item, status: computedStatus, remaining_amount_minor: remaining };
    });

    // Process Payments
    const payments = deal.payments || [];
    payments.sort((a, b) => new Date(b.payment_date) - new Date(a.payment_date) || new Date(b.created_at) - new Date(a.created_at));
    
    const formattedPayments = payments.map(pm => ({
      ...pm,
      created_by_name: pm.users?.name,
      users: undefined
    }));

    const activePayments = payments.filter(pm => pm.status !== 'VOIDED');
    const paid_amount_minor = activePayments.reduce((sum, pm) => sum + (pm.amount_minor || 0), 0);
    const remaining_debt_minor = Math.max(0, (deal.final_price_minor || 0) - paid_amount_minor);
    const paid_percent = deal.final_price_minor > 0 ? Number(((paid_amount_minor / deal.final_price_minor) * 100).toFixed(2)) : 0;

    const areaM2 = deal.units?.area_m2_x100 ? (deal.units.area_m2_x100 / 100) : 0;
    const computedDealPricePerM2 = deal.deal_price_per_m2_minor || (areaM2 > 0 ? Math.round(deal.final_price_minor / areaM2) : deal.units?.price_per_m2_minor);

    return {
      ...deal,
      lead_name: deal.leads?.full_name,
      lead_phone: deal.leads?.phone,
      lead_secondary_phone: deal.leads?.secondary_phone,
      passport_series: deal.leads?.passport_series,
      passport_number: deal.leads?.passport_number,
      passport_issued_by: deal.leads?.passport_issued_by,
      passport_issue_date: deal.leads?.passport_issue_date,
      birth_date: deal.leads?.birth_date,
      registration_address: deal.leads?.registration_address,
      inn: deal.leads?.inn,
      unit_number: deal.units?.unit_number,
      unit_rooms: deal.units?.rooms,
      area_m2_x100: deal.units?.area_m2_x100,
      deal_price_per_m2_minor: computedDealPricePerM2,
      unit_price_per_m2_minor: deal.units?.price_per_m2_minor,
      price_per_m2_minor: computedDealPricePerM2,
      exchange_rate: deal.exchange_rate ? Number(deal.exchange_rate) : null,
      unit_status: deal.units?.status,
      layout_name: deal.units?.layout_types?.name,
      layout_image_path: deal.units?.layout_types?.image_path,
      floor_number: deal.units?.floors?.floor_number,
      floor_name: deal.units?.floors?.name,
      section_name: deal.units?.floors?.sections?.name,
      building_name: deal.units?.floors?.sections?.buildings?.name,
      project_id: p.id,
      project_name: p.name,
      developer_name: p.developer_name,
      project_address: p.address,
      project_currency: p.currency,
      manager_name: deal.users?.name,
      manager_email: deal.users?.email,
      schedules,
      payments: formattedPayments,
      paid_amount_minor,
      total_paid_minor: paid_amount_minor,
      remaining_debt_minor,
      paid_percent,
      leads: undefined, units: undefined, users: undefined, deal_payment_schedules: undefined
    };
  }

  static async createDeal(data, responsibleUserId) {
    const db = getDB();
    const now = new Date().toISOString();
    const dealDate = data.deal_date || now.split('T')[0];

    // 1. Verify Unit
    const { data: unit, error: unitErr } = await db.from('units').select('*, floors(sections(buildings(projects(code, currency))))').eq('id', data.unit_id).single();
    if (unitErr) throw new AppError('Квартира не найдена', 404);
    if (unit.status !== 'AVAILABLE') throw new AppError('Квартира недоступна для оформления', 409);

    // 2. Contract Number
    const { count, error: countErr } = await db.from('deals').select('*', { count: 'exact', head: true });
    if (countErr) throw countErr;
    const pCur = unit.floors?.sections?.buildings?.projects?.currency || 'TJS';
    const contractNumber = String((count || 0) + 1).padStart(4, '0');

    const finalStatus = data.status || 'SIGNED';
    let reservationExpiresAt = data.reservation_expires_at || null;
    if (finalStatus === 'RESERVED' && !reservationExpiresAt) {
      const d = new Date();
      d.setDate(d.getDate() + 3);
      reservationExpiresAt = d.toISOString().split('T')[0];
    }

    const unitAreaM2 = unit.area_m2_x100 ? (unit.area_m2_x100 / 100) : 0;
    const computedDealPricePerM2 = data.deal_price_per_m2_minor || (unitAreaM2 > 0 ? Math.round(data.final_price_minor / unitAreaM2) : (unit.price_per_m2_minor || 0));

    // 3. Insert Deal
    const { data: newDeal, error: dealErr } = await db.from('deals').insert([{
      contract_number: contractNumber,
      lead_id: data.lead_id,
      unit_id: data.unit_id,
      responsible_user_id: responsibleUserId,
      status: finalStatus,
      payment_type: data.payment_type || 'FULL',
      currency: pCur,
      base_price_minor: data.base_price_minor,
      discount_minor: data.discount_minor || 0,
      final_price_minor: data.final_price_minor,
      deal_price_per_m2_minor: computedDealPricePerM2,
      exchange_rate: data.exchange_rate !== undefined && data.exchange_rate !== null ? parseFloat(data.exchange_rate) : null,
      down_payment_minor: data.down_payment_minor || 0,
      installment_months: data.installment_months || 0,
      barter_description: data.barter_description || null,
      barter_amount_minor: data.barter_amount_minor || 0,
      reservation_expires_at: reservationExpiresAt,
      deal_date: dealDate,
      signed_at: finalStatus === 'SIGNED' ? now : null,
      created_at: now,
      updated_at: now,
    }]).select().single();
    if (dealErr) throw dealErr;

    // 4 & 5. Update Unit and Lead
    await db.from('units').update({ status: finalStatus === 'SIGNED' ? 'SOLD' : 'RESERVED', updated_at: now }).eq('id', data.unit_id);
    await db.from('leads').update({ status: finalStatus === 'SIGNED' ? 'WON' : 'NEGOTIATION', updated_at: now }).eq('id', data.lead_id);

    // 6. Schedules
    if (data.schedules && data.schedules.length > 0) {
      const inserts = data.schedules.map((s, i) => ({
        deal_id: newDeal.id,
        payment_number: i + 1,
        due_date: s.due_date,
        amount_minor: s.amount_minor,
        paid_amount_minor: s.paid_amount_minor || 0,
        status: s.status || 'UPCOMING',
        created_at: now,
        updated_at: now
      }));
      await db.from('deal_payment_schedules').insert(inserts);
    }

    // 7. Initial Payment
    if (finalStatus === 'SIGNED' && data.record_initial_payment && data.down_payment_minor > 0) {
      const pkoRef = data.initial_payment_reference 
        ? (data.initial_payment_reference.trim().toUpperCase().startsWith('ПКО') ? data.initial_payment_reference.trim() : `ПКО-${data.initial_payment_reference.trim()}`)
        : `ПКО-${contractNumber}`;

      await db.from('payments').insert([{
        deal_id: newDeal.id,
        amount_minor: data.down_payment_minor,
        payment_date: data.initial_payment_date || dealDate,
        method: data.initial_payment_method || 'CASH',
        reference: pkoRef,
        comment: data.initial_payment_comment || `Первоначальный взнос по договору №${contractNumber}`,
        created_by_user_id: responsibleUserId,
        created_at: now
      }]);
    }

    return this.getDealById(newDeal.id);
  }

  static async signDeal(id, userId) {
    const db = getDB();
    const now = new Date().toISOString();
    
    const { data: deal } = await db.from('deals').select('*').eq('id', id).single();
    if (!deal) throw new AppError('Сделка не найдена', 404);
    if (deal.status === 'SIGNED') throw new AppError('Сделка уже подписана', 400);
    if (deal.status === 'CANCELLED') throw new AppError('Нельзя подписать отмененную сделку', 400);

    await db.from('deals').update({ status: 'SIGNED', signed_at: now, updated_at: now }).eq('id', id);
    await db.from('units').update({ status: 'SOLD', updated_at: now }).eq('id', deal.unit_id);
    await db.from('leads').update({ status: 'WON', updated_at: now }).eq('id', deal.lead_id);

    return this.getDealById(id);
  }

  static async cancelDeal(id, reason, userId, userRole) {
    const db = getDB();
    const now = new Date().toISOString();

    const { data: deal } = await db.from('deals').select('*').eq('id', id).single();
    if (!deal) throw new AppError('Сделка не найдена', 404);
    if (deal.status === 'CANCELLED') throw new AppError('Сделка уже отменена', 400);
    if (deal.status === 'SIGNED' && userRole !== 'ADMIN' && !reason) {
      throw new AppError('Для отмены подписанного договора укажите причину', 400);
    }

    await db.from('deals').update({ status: 'CANCELLED', cancelled_at: now, cancellation_reason: reason || 'Отменено пользователем', updated_at: now }).eq('id', id);
    await db.from('units').update({ status: 'AVAILABLE', updated_at: now }).eq('id', deal.unit_id);

    return this.getDealById(id);
  }

  static async extendReservation(id, newExpiresAt, userId) {
    const db = getDB();
    const now = new Date().toISOString();

    const { data: deal } = await db.from('deals').select('*').eq('id', id).single();
    if (!deal) throw new AppError('Сделка не найдена', 404);
    if (deal.status !== 'RESERVED') throw new AppError('Продлить можно только активную бронь', 400);

    await db.from('deals').update({ reservation_expires_at: newExpiresAt, updated_at: now }).eq('id', id);
    return this.getDealById(id);
  }

  static async recordPayment(dealId, data, userId) {
    const db = getDB();
    const now = new Date().toISOString();
    const paymentDate = data.payment_date || now.split('T')[0];
    const amountMinor = data.amount_minor;
    const idempotencyKey = data.idempotency_key;

    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new AppError('Ключ идемпотентности обязателен для проведения ПКО', 400);
    }
    if (!amountMinor || amountMinor <= 0) {
      throw new AppError('Сумма платежа должна быть больше нуля', 400);
    }

    // 1. Попытка вызова атомарной PostgreSQL RPC функции (единая транзакция)
    let paymentRecord = null;
    let isDuplicate = false;

    try {
      const { data: rpcResult, error: rpcErr } = await db.rpc('create_atomic_payment', {
        p_deal_id: Number(dealId),
        p_schedule_id: data.schedule_id ? Number(data.schedule_id) : null,
        p_amount_minor: Number(amountMinor),
        p_payment_date: String(paymentDate),
        p_method: String(data.method || 'CASH'),
        p_reference: data.reference ? String(data.reference) : null,
        p_comment: data.comment ? String(data.comment) : null,
        p_cash_desk_id: data.cash_desk_id,
        p_created_by_user_id: Number(userId),
        p_idempotency_key: String(idempotencyKey),
        p_currency: String(data.currency || 'USD'),
        p_payer_name: data.payer_name ? String(data.payer_name) : null,
        p_amount_tjs: data.amount_tjs !== undefined && data.amount_tjs !== null ? Number(data.amount_tjs) : null,
        p_amount_usd: data.amount_usd !== undefined && data.amount_usd !== null ? Number(data.amount_usd) : null,
        p_exchange_rate: data.exchange_rate !== undefined && data.exchange_rate !== null ? Number(data.exchange_rate) : null
      });

      if (!rpcErr && rpcResult && rpcResult.length > 0) {
        const resRow = rpcResult[0];
        isDuplicate = Boolean(resRow.is_duplicate);
        const { data: pData } = await db.from('payments').select('*').eq('id', resRow.payment_id).single();
        paymentRecord = pData;

        const fullDeal = await this.getDealById(dealId);
        return {
          ...fullDeal,
          payment: paymentRecord,
          isDuplicate
        };
      }

      if (rpcErr && (rpcErr.code === '42883' || rpcErr.message?.includes('function') || rpcErr.message?.includes('does not exist'))) {
        // Миграция 018 еще не применена в окружении — фолбэк с проверкой по idempotency_key
        return this.recordPaymentFallback(dealId, data, userId);
      } else if (rpcErr) {
        throw new AppError(rpcErr.message || 'Ошибка атомарного проведения ПКО', 400);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      return this.recordPaymentFallback(dealId, data, userId);
    }

    const fullDeal = await this.getDealById(dealId);
    return {
      ...fullDeal,
      payment: paymentRecord,
      isDuplicate
    };
  }

  static async recordPaymentFallback(dealId, data, userId) {
    const db = getDB();
    const now = new Date().toISOString();
    const paymentDate = data.payment_date || now.split('T')[0];
    const amountMinor = data.amount_minor;
    const idempotencyKey = data.idempotency_key || null;

    const { data: deal } = await db.from('deals').select('*').eq('id', dealId).single();
    if (!deal) throw new AppError('Сделка не найдена', 404);

    const settlementMethod = (data.settlement_method || 'CASH').toUpperCase();
    if (settlementMethod === 'INTERNAL_TRANSFER' || settlementMethod === 'CONVERSION') {
      throw new AppError('Внутренние перемещения и конвертации создаются через специальные разделы', 400);
    }

    if (settlementMethod === 'CASH' && !data.cash_desk_id) {
      throw new AppError('Касса получения средств обязательна для выбора', 400, 'CASH_DESK_REQUIRED');
    }

    if (idempotencyKey) {
      const { data: existingPayment } = await db
        .from('payments')
        .select('*')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

      if (existingPayment) {
        const fullDeal = await this.getDealById(dealId);
        return {
          ...fullDeal,
          payment: existingPayment,
          isDuplicate: true
        };
      }
    }

    let createdPayment = null;
    try {
      const { data: inserted, error: insErr } = await db.from('payments').insert([{
        deal_id: dealId,
        schedule_id: data.schedule_id || null,
        amount_minor: amountMinor,
        payment_date: paymentDate,
        method: data.method || 'CASH',
        settlement_method: settlementMethod,
        reference: data.reference || null,
        comment: data.comment || null,
        cash_desk_id: data.cash_desk_id || null,
        created_by_user_id: userId,
        idempotency_key: idempotencyKey,
        created_at: now
      }]).select().single();

      if (insErr) {
        if (insErr.code === '23505' || insErr.message?.includes('duplicate key') || insErr.message?.includes('idempotency_key')) {
          if (idempotencyKey) {
            const { data: existing } = await db.from('payments').select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
            if (existing) {
              const fullDeal = await this.getDealById(dealId);
              return {
                ...fullDeal,
                payment: existing,
                isDuplicate: true
              };
            }
          }
        }
        throw insErr;
      }

      createdPayment = inserted;
    } catch (err) {
      if (idempotencyKey) {
        const { data: existing } = await db.from('payments').select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
        if (existing) {
          const fullDeal = await this.getDealById(dealId);
          return {
            ...fullDeal,
            payment: existing,
            isDuplicate: true
          };
        }
      }
      throw err;
    }

    if (data.schedule_id && createdPayment) {
      const { data: schedule } = await db.from('deal_payment_schedules').select('*').eq('id', data.schedule_id).single();
      if (schedule) {
        const newPaid = (schedule.paid_amount_minor || 0) + amountMinor;
        const newStatus = newPaid >= schedule.amount_minor ? 'PAID' : 'PARTIAL';
        await db.from('deal_payment_schedules').update({ paid_amount_minor: newPaid, status: newStatus, updated_at: now }).eq('id', data.schedule_id);
      }
    }

    const fullDeal = await this.getDealById(dealId);
    return {
      ...fullDeal,
      payment: createdPayment,
      isDuplicate: false
    };
  }

  static async getAvailableUnits(projectId) {
    const db = getDB();
    let query = db.from('units').select(`
      id, unit_number, rooms, area_m2_x100, price_per_m2_minor, manual_total_price_minor, status,
      floors ( floor_number, name, sections ( name, buildings ( name, projects ( id, name, currency ) ) ) ),
      layout_types ( name, image_path )
    `).eq('status', 'AVAILABLE').is('archived_at', null);

    const { data, error } = await query;
    if (error) throw error;

    let units = data;
    if (projectId && projectId !== 'ALL') {
      units = units.filter(u => u.floors?.sections?.buildings?.projects?.id == projectId);
    }

    return units.map(u => {
      const p = u.floors?.sections?.buildings?.projects || {};
      return {
        id: u.id,
        unit_number: u.unit_number,
        rooms: u.rooms,
        area_m2_x100: u.area_m2_x100,
        price_per_m2_minor: u.price_per_m2_minor,
        manual_total_price_minor: u.manual_total_price_minor,
        status: u.status,
        floor_number: u.floors?.floor_number,
        floor_name: u.floors?.name,
        section_name: u.floors?.sections?.name,
        building_name: u.floors?.sections?.buildings?.name,
        project_id: p.id,
        project_name: p.name,
        project_currency: p.currency,
        layout_name: u.layout_types?.name,
        layout_image_path: u.layout_types?.image_path
      };
    });
  }

  static async updateDeal(id, data, userId) {
    const db = getDB();
    const now = new Date().toISOString();

    const { data: existingDeal } = await db.from('deals').select('*').eq('id', id).single();
    if (!existingDeal) throw new AppError('Сделка не найдена', 404);

    // 1. Paid deal protection check
    const { count: paymentsCount } = await db.from('payments').select('*', { count: 'exact', head: true }).eq('deal_id', id);
    const hasPaidPayments = (paymentsCount || 0) > 0;

    const financialKeys = ['base_price_minor', 'discount_minor', 'final_price_minor', 'deal_price_per_m2_minor', 'down_payment_minor', 'installment_months', 'exchange_rate', 'payment_type'];
    const containsFinancialUpdate = financialKeys.some(k => data[k] !== undefined);

    if (hasPaidPayments && containsFinancialUpdate) {
      throw new AppError('Запрещено изменять финансовые условия сделки, по которой уже проведены фактические платежи', 400);
    }

    const updatesJson = {};
    if (data.deal_date !== undefined) updatesJson.deal_date = data.deal_date;
    if (data.contract_number !== undefined) updatesJson.contract_number = data.contract_number;
    if (data.responsible_user_id !== undefined) updatesJson.responsible_user_id = data.responsible_user_id ? parseInt(data.responsible_user_id, 10) : null;
    if (data.reservation_expires_at !== undefined) updatesJson.reservation_expires_at = data.reservation_expires_at;
    if (data.payment_type !== undefined) updatesJson.payment_type = data.payment_type;
    if (data.installment_months !== undefined) updatesJson.installment_months = parseInt(data.installment_months, 10) || 0;
    if (data.barter_description !== undefined) updatesJson.barter_description = data.barter_description;
    if (data.barter_amount_minor !== undefined) updatesJson.barter_amount_minor = parseInt(data.barter_amount_minor, 10) || 0;
    if (data.base_price_minor !== undefined) updatesJson.base_price_minor = parseInt(data.base_price_minor, 10);
    if (data.discount_minor !== undefined) updatesJson.discount_minor = parseInt(data.discount_minor, 10) || 0;
    if (data.final_price_minor !== undefined) updatesJson.final_price_minor = parseInt(data.final_price_minor, 10);
    if (data.deal_price_per_m2_minor !== undefined) updatesJson.deal_price_per_m2_minor = parseInt(data.deal_price_per_m2_minor, 10);
    if (data.down_payment_minor !== undefined) updatesJson.down_payment_minor = parseInt(data.down_payment_minor, 10) || 0;
    if (data.exchange_rate !== undefined) updatesJson.exchange_rate = data.exchange_rate ? parseFloat(data.exchange_rate) : null;

    let leadUpdatesJson = null;
    if (data.lead_name || data.lead_phone || data.passport_series || data.passport_number || data.inn) {
      leadUpdatesJson = {};
      if (data.lead_name) leadUpdatesJson.full_name = data.lead_name;
      if (data.lead_phone) leadUpdatesJson.phone = data.lead_phone;
      if (data.passport_series !== undefined) leadUpdatesJson.passport_series = data.passport_series;
      if (data.passport_number !== undefined) leadUpdatesJson.passport_number = data.passport_number;
      if (data.inn !== undefined) leadUpdatesJson.inn = data.inn ? String(data.inn).trim() : null;
    }

    let schedulesJson = null;
    if (data.schedules && Array.isArray(data.schedules)) {
      schedulesJson = data.schedules.map((s, i) => ({
        payment_number: i + 1,
        due_date: s.due_date,
        amount_minor: parseInt(s.amount_minor, 10),
        paid_amount_minor: parseInt(s.paid_amount_minor || 0, 10),
        status: s.status || 'UPCOMING'
      }));
    } else if (
      !hasPaidPayments &&
      (data.final_price_minor !== undefined || data.down_payment_minor !== undefined || data.installment_months !== undefined || data.payment_type !== undefined) &&
      ((updatesJson.payment_type || existingDeal.payment_type) === 'INSTALLMENT')
    ) {
      const finalPrice = updatesJson.final_price_minor !== undefined ? updatesJson.final_price_minor : existingDeal.final_price_minor;
      const downPmt = updatesJson.down_payment_minor !== undefined ? updatesJson.down_payment_minor : existingDeal.down_payment_minor;
      const months = updatesJson.installment_months !== undefined ? updatesJson.installment_months : existingDeal.installment_months;
      const dDate = updatesJson.deal_date || existingDeal.deal_date || now.split('T')[0];

      if (months > 0 && finalPrice > downPmt) {
        const remainingMinor = finalPrice - downPmt;
        const monthlyMinor = Math.floor(remainingMinor / months);
        const remainderMinor = remainingMinor - (monthlyMinor * months);

        schedulesJson = [];
        const startDate = new Date(dDate);

        for (let i = 1; i <= months; i++) {
          const dueDate = new Date(startDate);
          dueDate.setMonth(dueDate.getMonth() + i);

          const paymentAmount = (i <= remainderMinor) ? monthlyMinor + 1 : monthlyMinor;
          schedulesJson.push({
            payment_number: i,
            due_date: dueDate.toISOString().split('T')[0],
            amount_minor: paymentAmount,
            paid_amount_minor: 0,
            status: 'UPCOMING'
          });
        }
      }
    }

    // Try calling atomic Postgres RPC
    try {
      const { data: rpcRes, error: rpcErr } = await db.rpc('update_deal_atomic', {
        p_deal_id: Number(id),
        p_user_id: Number(userId),
        p_updates_json: updatesJson,
        p_lead_updates_json: leadUpdatesJson,
        p_schedules_json: schedulesJson
      });

      if (!rpcErr) {
        return this.getDealById(id);
      }
      if (rpcErr && rpcErr.message?.includes('PAID_DEAL_FINANCIAL_EDIT_BLOCKED')) {
        throw new AppError('Запрещено изменять финансовые условия сделки, по которой уже проведены фактические платежи', 400);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err?.message?.includes('PAID_DEAL_FINANCIAL_EDIT_BLOCKED')) {
        throw new AppError('Запрещено изменять финансовые условия сделки, по которой уже проведены фактические платежи', 400);
      }
    }

    // Fallback JS-level execution with audit logging
    const { error: updateErr } = await db.from('deals').update({ ...updatesJson, updated_at: now }).eq('id', id);
    if (updateErr) throw updateErr;

    if (leadUpdatesJson) {
      await db.from('leads').update({ ...leadUpdatesJson, updated_at: now }).eq('id', existingDeal.lead_id);
    }

    if (schedulesJson !== null) {
      await db.from('deal_payment_schedules').delete().eq('deal_id', id);
      if (schedulesJson.length > 0) {
        const inserts = schedulesJson.map(s => ({
          deal_id: id,
          payment_number: s.payment_number,
          due_date: s.due_date,
          amount_minor: s.amount_minor,
          paid_amount_minor: s.paid_amount_minor || 0,
          status: s.status || 'UPCOMING',
          created_at: now,
          updated_at: now
        }));
        await db.from('deal_payment_schedules').insert(inserts);
      }
    }

    // Insert audit log
    try {
      await db.from('deal_audit_logs').insert([{
        deal_id: id,
        user_id: userId,
        action: 'UPDATE_DEAL',
        changes_json: { old: existingDeal, updates: updatesJson },
        created_at: now
      }]);
    } catch (auditErr) {
      console.warn('Failed to insert deal audit log:', auditErr);
    }

    return this.getDealById(id);
  }
}

