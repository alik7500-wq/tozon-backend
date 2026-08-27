import express from 'express';
import { getDB } from '../../db/connection.js';
import { DealsRepository } from '../deals/deals.repository.js';
import { LeadsRepository } from '../leads/leads.repository.js';
import { protect } from '../../middleware/auth.middleware.js';

const router = express.Router();

router.use(protect);

// GET /api/search?q=... - Global search across deals, leads/clients, and apartments
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || req.query.query || '').trim();
    if (!q || q.length < 1) {
      return res.status(200).json({
        status: 'success',
        data: { deals: [], leads: [], units: [], total: 0 }
      });
    }

    const db = getDB();

    // 1. Search Deals (by contract_number, lead_name, phone, unit_number, etc.)
    const dealsPromise = DealsRepository.findAll({ search: q })
      .then(deals => deals.slice(0, 5))
      .catch(e => {
        console.error('Error searching deals:', e);
        return [];
      });

    // 2. Search Leads & Clients (by name, phone, passport)
    const leadsPromise = LeadsRepository.findAll({ search: q })
      .then(leads => leads.slice(0, 5))
      .catch(e => {
        console.error('Error searching leads:', e);
        return [];
      });

    // 3. Search Units / Apartments (by unit_number)
    const unitsPromise = (async () => {
      try {
        let query = db.from('units').select(`
          id, unit_number, rooms, area_m2_x100, price_per_m2_minor, manual_total_price_minor, status,
          floors ( floor_number, sections ( name, buildings ( name, projects ( id, name, currency ) ) ) )
        `).is('archived_at', null);

        // Check if q is a unit number
        const num = parseInt(q, 10);
        if (!isNaN(num)) {
          query = query.eq('unit_number', num);
        }

        const { data, error } = await query.limit(10);
        if (error) throw error;

        let results = (data || []).map(u => {
          const p = u.floors?.sections?.buildings?.projects || {};
          return {
            id: u.id,
            unit_number: u.unit_number,
            rooms: u.rooms,
            area_m2: (u.area_m2_x100 || 0) / 100,
            price_per_m2: (u.price_per_m2_minor || 0) / 100,
            status: u.status,
            floor_number: u.floors?.floor_number,
            building_name: u.floors?.sections?.buildings?.name,
            project_id: p.id,
            project_name: p.name,
            currency: p.currency || 'USD'
          };
        });

        // If q is text (e.g. project name), filter results
        if (isNaN(num)) {
          const s = q.toLowerCase();
          results = results.filter(u => 
            String(u.unit_number).includes(s) ||
            (u.project_name && u.project_name.toLowerCase().includes(s)) ||
            (u.building_name && u.building_name.toLowerCase().includes(s))
          );
        }

        return results.slice(0, 5);
      } catch (e) {
        console.error('Error searching units:', e);
        return [];
      }
    })();

    const [deals, leads, units] = await Promise.all([dealsPromise, leadsPromise, unitsPromise]);

    const total = deals.length + leads.length + units.length;

    res.status(200).json({
      status: 'success',
      data: {
        deals,
        leads,
        units,
        total
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
