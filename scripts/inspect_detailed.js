import { connectDB } from '../src/db/connection.js';

async function main() {
  const db = connectDB();

  const { data: bldgs } = await db.from('buildings').select(`
    id, name, code,
    sections (
      id, name, code,
      floors (
        id, floor_number,
        units (
          id, unit_number, area_m2_x100, rooms, status, floor_id
        )
      )
    )
  `).order('id');

  for (const b of bldgs || []) {
    console.log(`\n================== BUILDING: ${b.name} (id: ${b.id}) ==================`);
    for (const s of b.sections || []) {
      console.log(`  SECTION: ${s.name} (id: ${s.id})`);
      s.floors.sort((a, b) => a.floor_number - b.floor_number);
      for (const f of s.floors || []) {
        console.log(`    Floor ${f.floor_number} (id: ${f.id}):`);
        // Sort units by id ascending to see the exact creation order
        f.units.sort((a, b) => a.id - b.id);
        for (const u of f.units) {
          console.log(`      id: ${u.id}, unit_number: "${u.unit_number}", area: ${(u.area_m2_x100 / 100).toFixed(2)} m², rooms: ${u.rooms}, status: ${u.status}`);
        }
      }
    }
  }
}

main().catch(console.error);
