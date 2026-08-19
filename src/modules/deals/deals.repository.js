import { getDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class DealsRepository {
  static async findAll(filters = {}) {
    const db = getDB();
    
    let query = db.from('deals').select(`
      *,
      leads ( full_name, phone, passport_series, passport_number ),
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
      
      const paymentsTotal = deal.payments ? deal.payments.reduce((acc, pm) => acc + (pm.amount_minor || 0), 0) : 0;
      const schedulesTotal = deal.deal_payment_schedules ? deal.deal_payment_schedules.reduce((acc, sc) => acc + (sc.paid_amount_minor || 0), 0) : 0;
      const totalPaid = Math.max(paymentsTotal, schedulesTotal);
      const remainingDebt = Math.max(0, deal.final_price_minor - totalPaid);
      const isOverdue = deal.status === 'RESERVED' && deal.reservation_expires_at && deal.reservation_expires_at < today;

      return {
        ...deal,
        lead_name: deal.leads?.full_name,
        lead_phone: deal.leads?.phone,
        passport_series: deal.leads?.passport_series,
        passport_number: deal.leads?.passport_number,
        unit_number: deal.units?.unit_number,
        unit_rooms: deal.units?.rooms,
        area_m2_x100: deal.units?.area_m2_x100,
        price_per_m2_minor: deal.units?.price_per_m2_minor,
        floor_number: deal.units?.floors?.floor_number,
        floor_name: deal.units?.floors?.name,
        section_name: deal.units?.floors?.sections?.name,
        building_name: deal.units?.floors?.sections?.buildings?.name,
        project_id: p.id,
        project_name: p.name,
        developer_name: p.developer_name,
        project_currency: p.currency,
        manager_name: deal.users?.name,
        total_paid_minor: totalPaid,
        remaining_debt_minor: remainingDebt,
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

    const { data: pmts } = await db.from('payments').select('amount_minor');
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
      leads ( full_name, phone, secondary_phone, passport_series, passport_number, passport_issued_by, passport_issue_date, birth_date, registration_address ),
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

    const paymentsTotal = payments.reduce((sum, pm) => sum + (pm.amount_minor || 0), 0);
    const schedulesTotal = schedules.reduce((sum, s) => sum + (s.paid_amount_minor || 0), 0);
    const total_paid_minor = Math.max(paymentsTotal, schedulesTotal);
    const remaining_debt_minor = Math.max(0, deal.final_price_minor - total_paid_minor);

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
      unit_number: deal.units?.unit_number,
      unit_rooms: deal.units?.rooms,
      area_m2_x100: deal.units?.area_m2_x100,
      price_per_m2_minor: deal.units?.price_per_m2_minor,
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
      total_paid_minor,
      remaining_debt_minor,
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
    const pCode = unit.floors?.sections?.buildings?.projects?.code || 'PRJ';
    const pCur = unit.floors?.sections?.buildings?.projects?.currency || 'TJS';
    const contractNumber = `${pCode}-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

    const finalStatus = data.status || 'SIGNED';
    let reservationExpiresAt = data.reservation_expires_at || null;
    if (finalStatus === 'RESERVED' && !reservationExpiresAt) {
      const d = new Date();
      d.setDate(d.getDate() + 3);
      reservationExpiresAt = d.toISOString().split('T')[0];
    }

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
      await db.from('payments').insert([{
        deal_id: newDeal.id,
        amount_minor: data.down_payment_minor,
        payment_date: dealDate,
        method: 'CASH',
        reference: 'ПВ при подписании',
        comment: 'Первоначальный взнос по договору',
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

    if (!amountMinor || amountMinor <= 0) throw new AppError('Сумма платежа должна быть больше нуля', 400);

    const { data: deal } = await db.from('deals').select('*').eq('id', dealId).single();
    if (!deal) throw new AppError('Сделка не найдена', 404);

    await db.from('payments').insert([{
      deal_id: dealId,
      schedule_id: data.schedule_id || null,
      amount_minor: amountMinor,
      payment_date: paymentDate,
      method: data.method || 'CASH',
      reference: data.reference || null,
      comment: data.comment || null,
      created_by_user_id: userId,
      created_at: now
    }]);

    if (data.schedule_id) {
      const { data: schedule } = await db.from('deal_payment_schedules').select('*').eq('id', data.schedule_id).single();
      if (schedule) {
        const newPaid = (schedule.paid_amount_minor || 0) + amountMinor;
        const newStatus = newPaid >= schedule.amount_minor ? 'PAID' : 'PARTIAL';
        await db.from('deal_payment_schedules').update({ paid_amount_minor: newPaid, status: newStatus, updated_at: now }).eq('id', data.schedule_id);
      }
    }

    return this.getDealById(dealId);
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
}
