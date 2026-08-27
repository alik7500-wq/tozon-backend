import { connectDB } from '../src/db/connection.js';

const db = connectDB();

const TOZON_PLAZA_MEDIA = [
  {
    category: 'EXTERIOR',
    title: 'Главный фасад — фронтальный ракурс',
    description: 'Центральный фасад ЖК TOZON PLAZA с панорамным остеклением, вентилируемым фасадом и вечерней архитектурной подсветкой.',
    sort_order: 1,
    is_cover: true,
    filename: 'facade_main_front.jpg',
    width: 1920,
    height: 1080
  },
  {
    category: 'EXTERIOR',
    title: 'Фасад — вид справа (Блок А)',
    description: 'Перспективный вид правого крыла жилого комплекса (Блок А) с угловыми панорамными балконами и террасами.',
    sort_order: 2,
    is_cover: false,
    filename: 'facade_block_a_right.jpg',
    width: 1920,
    height: 1080
  },
  {
    category: 'EXTERIOR',
    title: 'Фасад — вид слева (Блок Б)',
    description: 'Перспективный вид левого крыла жилого комплекса (Блок Б) со стороны прилегающей парковой зоны.',
    sort_order: 3,
    is_cover: false,
    filename: 'facade_block_b_left.jpg',
    width: 1920,
    height: 1080
  },
  {
    category: 'COURTYARD',
    title: 'Внутренний двор и детская площадка',
    description: 'Закрытый приватный двор без машин с травмобезопасным покрытием, современным детским городком и беседками.',
    sort_order: 4,
    is_cover: false,
    filename: 'courtyard_playground.jpg',
    width: 1920,
    height: 1080
  },
  {
    category: 'COURTYARD',
    title: 'Зона отдыха и ландшафтное озеленение',
    description: 'Ландшафтный дизайн дворовой территории: крупномерные деревья, цветущие кустарники, эко-скамейки и пешеходные дорожки.',
    sort_order: 5,
    is_cover: false,
    filename: 'courtyard_landscape_lounge.jpg',
    width: 1920,
    height: 1080
  },
  {
    category: 'COURTYARD',
    title: 'Дворовая подсветка и вечерний уют',
    description: 'Мягусветные парковые фонари, акцентная подсветка газонов и фасада во внутреннем дворе в вечернее время.',
    sort_order: 6,
    is_cover: false,
    filename: 'courtyard_evening_lighting.jpg',
    width: 1920,
    height: 1080
  },
  {
    category: 'MASTERPLAN',
    title: 'Генплан — перспективный вид сверху 1',
    description: 'Общий вид жилого комплекса TOZON PLAZA с высоты птичьего полета с прилегающими улицами и инфраструктурой микрорайона.',
    sort_order: 7,
    is_cover: false,
    filename: 'masterplan_aerial_view_1.jpg',
    width: 1920,
    height: 1080
  },
  {
    category: 'MASTERPLAN',
    title: 'Генплан — посадка здания и транспортные подъезды 2',
    description: 'Вид сверху на схему въезда в подземный паркинг, гостевую стоянку и транспортные развязки ул. Б. Ёкубов.',
    sort_order: 8,
    is_cover: false,
    filename: 'masterplan_aerial_view_2.jpg',
    width: 1920,
    height: 1080
  },
  {
    category: 'COMMERCIAL',
    title: 'Первый уровень и парадная входная группа',
    description: 'Дизайнерское лобби с консьерж-сервисом, высокими потолками (4.2 м) и витринами коммерческих помещений.',
    sort_order: 9,
    is_cover: false,
    filename: 'entrance_commercial_lobby.jpg',
    width: 1920,
    height: 1080
  }
];

function createMinimalJpg(label) {
  // Minimal valid 1x1 base64 JPEG
  const base64Jpg = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  return Buffer.from(base64Jpg, 'base64');
}

async function seed() {
  console.log('=== SEEDING 9 VISUAL RENDERS FOR ЖК TOZON PLAZA (Project #3) ===');

  const projectId = 3;
  const now = new Date().toISOString();

  // 1. Ensure storage bucket
  const { data: buckets } = await db.storage.listBuckets();
  if (!buckets?.some(b => b.id === 'project-media')) {
    await db.storage.createBucket('project-media', { public: true });
    console.log('[OK] Created storage bucket: project-media');
  }

  // 2. Clear previous media for project 3 to avoid duplication on re-run
  const { error: delErr } = await db.from('project_media').delete().eq('project_id', projectId);
  if (delErr) console.warn('Warning deleting existing media:', delErr.message);

  // 3. Upload files & insert records
  for (const item of TOZON_PLAZA_MEDIA) {
    const storagePath = `projects/${projectId}/media/${item.filename}`;
    const fileBuffer = createMinimalJpg(item.title);

    await db.storage.from('project-media').upload(storagePath, fileBuffer, {
      contentType: 'image/jpeg',
      upsert: true
    });

    const { data: inserted, error: insErr } = await db.from('project_media').insert([{
      project_id: projectId,
      category: item.category,
      title: item.title,
      description: item.description,
      storage_path: storagePath,
      mime_type: 'image/jpeg',
      sort_order: item.sort_order,
      is_cover: item.is_cover,
      is_active: true,
      metadata: {
        width: item.width,
        height: item.height,
        source: 'PILOT / TOZON PLAZA RENDERS'
      },
      created_at: now,
      updated_at: now
    }]).select().single();

    if (insErr) {
      console.error(`[ERROR] inserting ${item.title}:`, insErr.message);
    } else {
      console.log(`[PASS] Inserted ID ${inserted.id}: [${item.category}] "${item.title}" ${item.is_cover ? '★ COVER' : ''}`);
    }
  }

  // 4. Verify counts
  const { data: allMedia } = await db.from('project_media').select('*').eq('project_id', projectId);
  console.log(`\n[TOTAL] Successfully seeded ${allMedia.length} visual renders for Project #${projectId}.`);
}

seed().catch(err => {
  console.error('Fatal seed error:', err);
  process.exit(1);
});
