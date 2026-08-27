import { connectDB } from '../src/db/connection.js';
import { ProjectMediaRepository } from '../src/modules/projectMedia/projectMedia.repository.js';

const db = connectDB();

async function checkMedia() {
  const { data: media, error } = await db
    .from('project_media')
    .select('*')
    .eq('project_id', 3)
    .order('sort_order', { ascending: true });

  if (error) {
    console.error('DB Error:', error);
    process.exit(1);
  }

  console.log(`Found ${media.length} media records for Project #3:`);
  for (const m of media) {
    const signedUrl = await ProjectMediaRepository.getSignedReadUrl('project-media', m.storage_path);
    const hasUrl = !!signedUrl && signedUrl.startsWith('http');
    console.log(`- #${m.id} [${m.category}] "${m.title}" (sort: ${m.sort_order}) ${m.is_cover ? '★ COVER' : ''} -> URL valid: ${hasUrl}`);
  }

  const covers = media.filter(m => m.is_cover);
  console.log(`\nCover check: ${covers.length} cover(s) found. Valid single cover: ${covers.length === 1 ? 'YES' : 'NO'}`);
}

checkMedia().catch(console.error);
