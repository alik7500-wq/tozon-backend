import fs from 'fs';
import path from 'path';
import { connectDB } from '../src/db/connection.js';
import axios from 'axios';

const db = connectDB();

const brainDir = 'C:/Users/User/.gemini/antigravity-ide/brain/82ebe70c-c1c9-48d3-b399-922c8d132c13';

const IMAGE_MAPPINGS = [
  {
    storagePath: 'projects/3/media/facade_main_front.jpg',
    prefix: 'facade_main_front_',
    category: 'EXTERIOR',
    title: 'Главный фасад — фронтальный ракурс'
  },
  {
    storagePath: 'projects/3/media/facade_block_a_right.jpg',
    prefix: 'facade_block_a_right_',
    category: 'EXTERIOR',
    title: 'Фасад — вид справа (Блок А)'
  },
  {
    storagePath: 'projects/3/media/facade_block_b_left.jpg',
    prefix: 'facade_block_b_left_',
    category: 'EXTERIOR',
    title: 'Фасад — вид слева (Блок Б)'
  },
  {
    storagePath: 'projects/3/media/courtyard_playground.jpg',
    prefix: 'courtyard_playground_',
    category: 'COURTYARD',
    title: 'Внутренний двор и детская площадка'
  },
  {
    storagePath: 'projects/3/media/courtyard_landscape_lounge.jpg',
    prefix: 'courtyard_landscape_lounge_',
    category: 'COURTYARD',
    title: 'Зона отдыха и ландшафтное озеленение'
  },
  {
    storagePath: 'projects/3/media/courtyard_evening_lighting.jpg',
    prefix: 'courtyard_evening_lighting_',
    category: 'COURTYARD',
    title: 'Дворовая подсветка и вечерний уют'
  },
  {
    storagePath: 'projects/3/media/masterplan_aerial_view_1.jpg',
    prefix: 'masterplan_aerial_view_1_',
    category: 'MASTERPLAN',
    title: 'Генплан — перспективный вид сверху 1'
  },
  {
    storagePath: 'projects/3/media/masterplan_aerial_view_2.jpg',
    prefix: 'masterplan_aerial_view_2_',
    category: 'MASTERPLAN',
    title: 'Генплан — посадка здания и транспортные подъезды 2'
  },
  {
    storagePath: 'projects/3/media/entrance_commercial_lobby.jpg',
    prefix: 'entrance_commercial_lobby_',
    category: 'COMMERCIAL',
    title: 'Первый уровень и парадная входная группа'
  }
];

async function uploadRealImages() {
  console.log('=== UPLOADING REAL 9 TOZON PLAZA HIGH-RES RENDERS TO STORAGE ===\n');

  const filesInBrain = fs.readdirSync(brainDir);

  for (const item of IMAGE_MAPPINGS) {
    const foundFile = filesInBrain
      .filter(f => f.startsWith(item.prefix) && f.endsWith('.jpg'))
      .sort()
      .pop();

    if (!foundFile) {
      console.error(`[ERROR] File matching prefix ${item.prefix} not found in brain dir`);
      continue;
    }

    const localPath = path.join(brainDir, foundFile);
    const fileBuffer = fs.readFileSync(localPath);
    const fileSize = fs.statSync(localPath).size;

    console.log(`Uploading ${foundFile} (${(fileSize / 1024 / 1024).toFixed(2)} MB) -> ${item.storagePath}...`);

    const { error: upErr } = await db.storage.from('project-media').upload(
      item.storagePath,
      fileBuffer,
      {
        contentType: 'image/jpeg',
        upsert: true
      }
    );

    if (upErr) {
      console.error(`[ERROR] Upload failed for ${item.storagePath}:`, upErr.message);
    } else {
      console.log(`[PASS] Uploaded ${item.title} -> ${item.storagePath} (${(fileSize / 1024).toFixed(1)} KB)`);
    }
  }

  console.log('\n=== VERIFYING DOWNLOADS & SIZES VIA SIGNED READ URLS ===\n');
  const { data: records } = await db.from('project_media').select('*').eq('project_id', 3).order('sort_order', { ascending: true });

  for (const rec of records || []) {
    const { data: sData, error: sErr } = await db.storage.from('project-media').createSignedUrl(rec.storage_path, 3600);
    if (sErr || !sData?.signedUrl) {
      console.error(`[FAIL] Signed URL error for #${rec.id} ${rec.title}:`, sErr?.message);
      continue;
    }

    const res = await axios.get(sData.signedUrl, { responseType: 'arraybuffer' });
    const downloadedSize = res.data.length;
    const contentType = res.headers['content-type'];

    console.log(`[VERIFIED] #${rec.id} [${rec.category}] "${rec.title}" -> HTTP ${res.status} | Type: ${contentType} | Size: ${(downloadedSize / 1024).toFixed(1)} KB | Cover: ${rec.is_cover ? '★' : '-'}`);
  }
}

uploadRealImages().catch(err => {
  console.error('Fatal upload error:', err);
  process.exit(1);
});
