import { connectDB } from '../src/db/connection.js';

const forceDeleteProject = async (projectId) => {
  const db = connectDB();
  
  console.log(`Searching for data linked to Project ID: ${projectId}...`);
  
  // 1. Get buildings
  const { data: buildings, error: bErr } = await db.from('buildings').select('id').eq('project_id', projectId);
  if (bErr) throw bErr;
  
  const buildingIds = buildings ? buildings.map(b => b.id) : [];
  if (buildingIds.length === 0) {
    console.log('No buildings found. Deleting project directly...');
    await db.from('projects').delete().eq('id', projectId);
    console.log('Project deleted.');
    process.exit(0);
  }
  
  // 2. Get sections
  const { data: sections, error: sErr } = await db.from('sections').select('id').in('building_id', buildingIds);
  if (sErr) throw sErr;
  const sectionIds = sections ? sections.map(s => s.id) : [];
  
  if (sectionIds.length > 0) {
    // 3. Get floors
    const { data: floors, error: fErr } = await db.from('floors').select('id').in('section_id', sectionIds);
    if (fErr) throw fErr;
    const floorIds = floors ? floors.map(f => f.id) : [];
    
    if (floorIds.length > 0) {
      // 4. Get units
      const { data: units, error: uErr } = await db.from('units').select('id').in('floor_id', floorIds);
      if (uErr) throw uErr;
      const unitIds = units ? units.map(u => u.id) : [];
      
      if (unitIds.length > 0) {
        // 5. Get deals linked to these units
        const { data: deals, error: dErr } = await db.from('deals').select('id').in('unit_id', unitIds);
        if (dErr) throw dErr;
        const dealIds = deals ? deals.map(d => d.id) : [];
        
        if (dealIds.length > 0) {
          console.log(`Found ${dealIds.length} deals linked to this project. Deleting them (this will cascade delete payments and schedules)...`);
          // Note: Payments and Schedules have ON DELETE CASCADE referencing deals
          const { error: delDealsErr } = await db.from('deals').delete().in('id', dealIds);
          if (delDealsErr) throw delDealsErr;
          console.log('Deals deleted.');
        }
      }
    }
  }
  
  // Finally, delete the project (this will cascade delete buildings, sections, floors, units, maps)
  console.log('Deleting the project itself...');
  const { error: delProjErr } = await db.from('projects').delete().eq('id', projectId);
  if (delProjErr) throw delProjErr;
  
  console.log(`Successfully deleted Project ID: ${projectId} and all its dependencies.`);
  process.exit(0);
};

const projectId = process.argv[2];
if (!projectId) {
  console.error('Please provide a Project ID. Example: node force_delete_project.js 2');
  process.exit(1);
}

forceDeleteProject(projectId).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
