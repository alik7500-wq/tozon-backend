import { connectDB } from '../src/db/connection.js';
import { createPilotFloorGLB } from './generate_pilot_floor_glb.js';
import { createSampleGLB } from './generate_sample_glb.js';
import { createSamplePanoramaPNG } from './generate_sample_panorama.js';

const db = connectDB();

async function fixStorageAndScenes() {
  console.log('=== RESTORING PILOT 3D & 360 STORAGE ASSETS ===');

  // 1. Upload pilot floor GLB and demo building GLB
  const floorGlbBuffer = createPilotFloorGLB();
  const demoGlbBuffer = createSampleGLB();

  const { error: floorErr } = await db.storage.from('3d-models').upload(
    'projects/3/3d/pilot_block_a_floor_2.glb',
    floorGlbBuffer,
    { contentType: 'model/gltf-binary', upsert: true }
  );
  console.log('Upload pilot_block_a_floor_2.glb:', floorErr ? floorErr.message : 'OK');

  const { error: demoErr } = await db.storage.from('3d-models').upload(
    'projects/3/3d/demo_building_block.glb',
    demoGlbBuffer,
    { contentType: 'model/gltf-binary', upsert: true }
  );
  console.log('Upload demo_building_block.glb:', demoErr ? demoErr.message : 'OK');

  // 2. Upload sample panoramas
  const livingPanoBuffer = createSamplePanoramaPNG();
  const bedroomPanoBuffer = createSamplePanoramaPNG();

  const { error: pano1Err } = await db.storage.from('panoramas-360').upload(
    'projects/3/panoramas/living_room.png',
    livingPanoBuffer,
    { contentType: 'image/png', upsert: true }
  );
  console.log('Upload living_room.png:', pano1Err ? pano1Err.message : 'OK');

  const { error: pano2Err } = await db.storage.from('panoramas-360').upload(
    'projects/3/panoramas/bedroom.png',
    bedroomPanoBuffer,
    { contentType: 'image/png', upsert: true }
  );
  console.log('Upload bedroom.png:', pano2Err ? pano2Err.message : 'OK');

  // 3. Fix active Scene 3D
  // Deactivate all broken scenes
  await db.from('scene_3d').update({ is_active: false }).eq('project_id', 3);

  // Set the pilot floor scene active with valid storage path
  let { data: activeScene } = await db.from('scene_3d')
    .select('*')
    .eq('project_id', 3)
    .eq('storage_path', 'projects/3/3d/pilot_block_a_floor_2.glb')
    .maybeSingle();

  if (!activeScene) {
    const { data: newScene, error: createErr } = await db.from('scene_3d').insert([{
      project_id: 3,
      name: 'PILOT: Блок А - Типовой Этаж 2 (7 квартир)',
      scene_type: 'FLOOR',
      storage_path: 'projects/3/3d/pilot_block_a_floor_2.glb',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]).select().single();
    if (createErr) console.error('Error creating scene:', createErr);
    activeScene = newScene;
  } else {
    await db.from('scene_3d').update({ is_active: true }).eq('id', activeScene.id);
  }

  console.log('[OK] Active Scene set to ID:', activeScene.id, activeScene.name);

  // Ensure entity mappings for active scene
  const { data: units } = await db.from('units').select('id, unit_number').order('id', { ascending: true }).limit(7);
  for (let i = 0; i < (units || []).length; i++) {
    const meshKey = `APT_A_1_02_00${i + 1}`;
    const unit = units[i];
    
    // check if mapping exists
    const { data: existing } = await db.from('scene_3d_entities')
      .select('id')
      .eq('scene_id', activeScene.id)
      .eq('mesh_key', meshKey)
      .maybeSingle();

    if (!existing) {
      await db.from('scene_3d_entities').insert([{
        scene_id: activeScene.id,
        mesh_key: meshKey,
        entity_type: 'UNIT',
        entity_id: unit.id,
        interaction_type: 'SELECT',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]);
    }
  }
  console.log('[OK] Mapped 7 units to active Scene #' + activeScene.id);

  // 4. Fix active Tour 360
  // Deactivate all tours for project 3
  await db.from('tours_360').update({ is_active: false }).eq('project_id', 3);

  // Check or create pilot tour
  let { data: pilotTour } = await db.from('tours_360')
    .select('*')
    .eq('project_id', 3)
    .eq('name', 'Шоурум 2-комнатной квартиры (360°)')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!pilotTour) {
    const { data: createdTour } = await db.from('tours_360').insert([{
      project_id: 3,
      name: 'Шоурум 2-комнатной квартиры (360°)',
      tour_type: 'SHOWROOM',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]).select().single();
    pilotTour = createdTour;
  } else {
    await db.from('tours_360').update({ is_active: true }).eq('id', pilotTour.id);
  }
  console.log('[OK] Active Tour set to ID:', pilotTour.id, pilotTour.name);

  // Ensure panoramas for pilotTour
  await db.from('panorama_360').delete().eq('tour_id', pilotTour.id);

  const { data: pano1 } = await db.from('panorama_360').insert([{
    tour_id: pilotTour.id,
    name: 'Гостиная и кухня',
    storage_path: 'projects/3/panoramas/living_room.png',
    initial_pitch: 0,
    initial_yaw: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }]).select().single();

  const { data: pano2 } = await db.from('panorama_360').insert([{
    tour_id: pilotTour.id,
    name: 'Спальня и балкон',
    storage_path: 'projects/3/panoramas/bedroom.png',
    initial_pitch: 0,
    initial_yaw: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }]).select().single();

  // Add navigation hotspots
  await db.from('panorama_hotspots').insert([
    {
      panorama_id: pano1.id,
      hotspot_type: 'NAVIGATION',
      pitch: 0,
      yaw: 1.57,
      target_panorama_id: pano2.id,
      label: 'В спальню →',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      panorama_id: pano2.id,
      hotspot_type: 'NAVIGATION',
      pitch: 0,
      yaw: -1.57,
      target_panorama_id: pano1.id,
      label: '← В гостиную',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      panorama_id: pano1.id,
      hotspot_type: 'UNIT',
      pitch: -0.2,
      yaw: 0,
      target_entity_type: 'UNIT',
      target_entity_id: units[0].id,
      label: `Квартира № ${units[0].unit_number}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      panorama_id: pano1.id,
      hotspot_type: 'INFO',
      pitch: 0.3,
      yaw: 0.8,
      label: 'Панорамные окна',
      metadata: {
        description: 'Энергосберегающий пятикамерный профиль с двойным стеклопакетом и защитой от ультрафиолета.'
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  ]);

  console.log('[OK] Configured 2 Panoramas with Hotspots for Tour #' + pilotTour.id);
  console.log('=== PILOT ASSETS RESTORATION COMPLETE ===');
}

fixStorageAndScenes().catch(err => {
  console.error('Fix error:', err);
  process.exit(1);
});
