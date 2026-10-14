import { getServiceDB } from '../../db/connection.js';

export class SalesPlansRepository {
  /**
   * Get all sales plans for a given month period
   */
  static async getPlansByPeriod(period, filters = {}) {
    const db = getServiceDB();
    let query = db
      .from('sales_plans')
      .select(`
        id,
        period,
        scope_type,
        manager_id,
        project_id,
        building_id,
        target_deals_count,
        target_volume_minor,
        currency,
        status,
        created_by,
        approved_by,
        approved_at,
        created_at,
        updated_at,
        users!manager_id(id, name, role),
        projects!project_id(id, name, code, currency),
        buildings!building_id(id, name, code, project_id)
      `)
      .eq('period', period)
      .order('id', { ascending: true });

    if (filters.scope_type) {
      query = query.eq('scope_type', filters.scope_type);
    }
    if (filters.manager_id) {
      query = query.eq('manager_id', filters.manager_id);
    }
    if (filters.project_id) {
      query = query.eq('project_id', filters.project_id);
    }
    if (filters.building_id) {
      query = query.eq('building_id', filters.building_id);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Failed to get sales plans:', error.message);
      throw error;
    }
    return data || [];
  }

  /**
   * Get a plan by ID
   */
  static async getPlanById(id) {
    const db = getServiceDB();
    const { data, error } = await db
      .from('sales_plans')
      .select('*')
      .eq('id', id)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Failed to get plan by id:', error.message);
      throw error;
    }
    return data || null;
  }

  /**
   * Find existing plan by unique scope criteria
   */
  static async findExistingPlan(period, scopeType, { managerId = null, projectId = null, buildingId = null }) {
    const db = getServiceDB();
    let query = db
      .from('sales_plans')
      .select('*')
      .eq('period', period)
      .eq('scope_type', scopeType);

    if (scopeType === 'DEPARTMENT') {
      query = query.is('manager_id', null).is('project_id', null).is('building_id', null);
    } else if (scopeType === 'MANAGER') {
      query = query.eq('manager_id', managerId);
    } else if (scopeType === 'PROJECT') {
      query = query.eq('project_id', projectId);
    } else if (scopeType === 'BUILDING') {
      query = query.eq('building_id', buildingId);
    }

    const { data, error } = await query.maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  /**
   * Upsert a sales plan
   */
  static async savePlan(planData) {
    const db = getServiceDB();
    const payload = {
      period: planData.period,
      scope_type: planData.scope_type,
      manager_id: planData.manager_id || null,
      project_id: planData.project_id || null,
      building_id: planData.building_id || null,
      target_deals_count: planData.target_deals_count || 0,
      target_volume_minor: planData.target_volume_minor || 0,
      currency: planData.currency || 'USD',
      status: planData.status || 'DRAFT',
      updated_at: new Date().toISOString()
    };

    if (planData.id) {
      payload.id = planData.id;
      const { data, error } = await db
        .from('sales_plans')
        .update(payload)
        .eq('id', planData.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      payload.created_by = planData.created_by || null;
      payload.created_at = new Date().toISOString();
      const { data, error } = await db
        .from('sales_plans')
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      return data;
    }
  }

  /**
   * Approve a plan
   */
  static async approvePlan(id, userId) {
    const db = getServiceDB();
    const now = new Date().toISOString();
    const { data, error } = await db
      .from('sales_plans')
      .update({
        status: 'APPROVED',
        approved_by: userId,
        approved_at: now,
        updated_at: now
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Record plan audit log
   */
  static async createAuditLog({ sales_plan_id, action, old_values, new_values, reason, changed_by_user_id }) {
    const db = getServiceDB();
    const { data, error } = await db
      .from('sales_plan_audit_logs')
      .insert({
        sales_plan_id,
        action,
        old_values: old_values ? JSON.stringify(old_values) : null,
        new_values: JSON.stringify(new_values),
        reason: reason || 'Обновление параметров плана продаж',
        changed_by_user_id,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to create sales plan audit log:', error.message);
      // Non-blocking log if schema missing in local dry runs
    }
    return data;
  }

  /**
   * Get audit logs for a given period or plan
   */
  static async getAuditLogs(filters = {}) {
    const db = getServiceDB();
    let query = db
      .from('sales_plan_audit_logs')
      .select(`
        id,
        sales_plan_id,
        action,
        old_values,
        new_values,
        reason,
        changed_by_user_id,
        created_at,
        users!changed_by_user_id(id, name, role),
        sales_plans(id, period, scope_type)
      `)
      .order('created_at', { ascending: false });

    if (filters.planId) {
      query = query.eq('sales_plan_id', filters.planId);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Failed to get sales plan audit logs:', error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Fetch all deals with full hierarchy links for accurate fact calculations
   */
  static async getAllDealsWithHierarchy() {
    const db = getServiceDB();
    const { data, error } = await db
      .from('deals')
      .select(`
        id,
        contract_number,
        lead_id,
        unit_id,
        responsible_user_id,
        status,
        currency,
        final_price_minor,
        base_price_minor,
        discount_minor,
        down_payment_minor,
        deal_date,
        signed_at,
        cancelled_at,
        cancellation_reason,
        created_at,
        units (
          id,
          unit_number,
          rooms,
          area_m2_x100,
          status,
          floors (
            id,
            floor_number,
            sections (
              id,
              name,
              buildings (
                id,
                name,
                code,
                project_id,
                projects (
                  id,
                  name,
                  code,
                  currency
                )
              )
            )
          )
        ),
        leads!lead_id (
          id,
          full_name,
          phone,
          status
        ),
        users!responsible_user_id (
          id,
          name,
          role
        )
      `);

    if (error) {
      console.error('Failed to fetch deals with hierarchy:', error.message);
      throw error;
    }
    return data || [];
  }

  /**
   * Fetch active payments linked to deals for cash collection comparison
   */
  static async getActivePaymentsForPeriod(period) {
    const db = getServiceDB();
    const startDate = `${period}-01`;
    // Last day of month
    const [y, m] = period.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const endDate = `${period}-${String(lastDay).padStart(2, '0')}`;

    const { data, error } = await db
      .from('payments')
      .select('id, deal_id, amount_minor, currency, amount_usd, amount_tjs, payment_date, status')
      .eq('status', 'ACTIVE')
      .not('deal_id', 'is', null)
      .gte('payment_date', startDate)
      .lte('payment_date', endDate);

    if (error) {
      console.error('Failed to fetch active payments:', error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Fetch pipeline leads (RESERVED, NEGOTIATION, IN_PROGRESS)
   */
  static async getPipelineLeads() {
    const db = getServiceDB();
    const { data, error } = await db
      .from('leads')
      .select('id, full_name, status, responsible_user_id, interested_project_id, created_at')
      .in('status', ['IN_PROGRESS', 'NEGOTIATION']);

    if (error) {
      console.error('Failed to fetch pipeline leads:', error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Fetch active sales managers
   */
  static async getSalesManagers() {
    const db = getServiceDB();
    const { data, error } = await db
      .from('users')
      .select('id, name, email, role, is_active')
      .in('role', ['SALES_MANAGER', 'ADMIN'])
      .order('id', { ascending: true });

    if (error) throw error;
    return (data || []).filter(u => u.is_active === 1 || u.is_active === true || u.is_active === '1');
  }

  /**
   * Fetch projects and buildings (blocks)
   */
  static async getProjectsAndBuildings() {
    const db = getServiceDB();
    const { data: projects, error: pErr } = await db
      .from('projects')
      .select('id, name, code, currency')
      .order('id');
    if (pErr) throw pErr;

    const { data: buildings, error: bErr } = await db
      .from('buildings')
      .select('id, project_id, name, code, sort_order')
      .order('sort_order', { ascending: true });
    if (bErr) throw bErr;

    return { projects: projects || [], buildings: buildings || [] };
  }
}
