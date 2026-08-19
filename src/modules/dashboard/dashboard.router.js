import express from 'express';
import { getDB } from '../../db/connection.js';
import { protect } from '../../middleware/auth.middleware.js';

const router = express.Router();
router.use(protect);

router.get('/stats', async (req, res, next) => {
  try {
    const db = getDB();

    // 1. Units Stats
    const { data: units } = await db.from('units').select('status').is('archived_at', null);
    const unitStats = { total_units: 0, available_units: 0, reserved_units: 0, sold_units: 0, blocked_units: 0 };
    (units || []).forEach(u => {
      unitStats.total_units++;
      if (u.status === 'AVAILABLE') unitStats.available_units++;
      else if (u.status === 'RESERVED') unitStats.reserved_units++;
      else if (u.status === 'SOLD') unitStats.sold_units++;
      else if (u.status === 'BLOCKED') unitStats.blocked_units++;
    });

    // 2. Leads Stats
    const { data: leads } = await db.from('leads').select('status').is('archived_at', null);
    const leadStats = { total_leads: 0, new_leads: 0, in_progress_leads: 0, negotiation_leads: 0, won_leads: 0, lost_leads: 0 };
    (leads || []).forEach(l => {
      leadStats.total_leads++;
      if (l.status === 'NEW') leadStats.new_leads++;
      else if (l.status === 'IN_PROGRESS') leadStats.in_progress_leads++;
      else if (l.status === 'NEGOTIATION') leadStats.negotiation_leads++;
      else if (l.status === 'WON') leadStats.won_leads++;
      else if (l.status === 'LOST') leadStats.lost_leads++;
    });

    // 3. Projects Count
    const { count: projectCount } = await db.from('projects').select('*', { count: 'exact', head: true }).is('archived_at', null);
    const projectStats = { total_projects: projectCount || 0 };

    // 4. Deals Stats
    const { data: signedDeals } = await db.from('deals').select('final_price_minor').eq('status', 'SIGNED');
    const dealStats = { 
      total_deals: (signedDeals || []).length, 
      total_volume_minor: (signedDeals || []).reduce((acc, d) => acc + (d.final_price_minor || 0), 0)
    };

    // 5. Recent Deals
    const { data: recentDealsData } = await db.from('deals').select('id, contract_number, status, payment_type, currency, final_price_minor, deal_date, created_at, leads(full_name, phone), units(unit_number, rooms, floors(sections(buildings(projects(name)))))').order('id', { ascending: false }).limit(5);
    const recentDeals = (recentDealsData || []).map(d => ({
      ...d,
      lead_name: d.leads?.full_name,
      lead_phone: d.leads?.phone,
      unit_number: d.units?.unit_number,
      unit_rooms: d.units?.rooms,
      project_name: d.units?.floors?.sections?.buildings?.projects?.name,
      building_name: d.units?.floors?.sections?.buildings?.name,
      leads: undefined, units: undefined
    }));

    // 6. Upcoming Payments
    const { data: upcomingData } = await db.from('deal_payment_schedules').select('id, deal_id, payment_number, due_date, amount_minor, status, deals(contract_number, currency, status, leads(full_name, phone), units(unit_number, floors(sections(buildings(projects(name))))))').order('due_date', { ascending: true }).limit(20);
    const upcomingPayments = (upcomingData || []).filter(s => s.deals?.status === 'SIGNED' || s.deals?.status === 'RESERVED').slice(0, 10).map(s => ({
      ...s,
      contract_number: s.deals?.contract_number,
      currency: s.deals?.currency,
      lead_name: s.deals?.leads?.full_name,
      lead_phone: s.deals?.leads?.phone,
      unit_number: s.deals?.units?.unit_number,
      project_name: s.deals?.units?.floors?.sections?.buildings?.projects?.name,
      deals: undefined
    }));

    res.status(200).json({
      status: 'success',
      data: {
        units: unitStats,
        leads: leadStats,
        projects: projectStats,
        deals: dealStats,
        recentDeals,
        upcomingPayments,
      },
    });
  } catch (error) { next(error); }
});

export default router;
