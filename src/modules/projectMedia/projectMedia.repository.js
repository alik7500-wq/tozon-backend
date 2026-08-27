import { getDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class ProjectMediaRepository {
  /**
   * Helper to generate a signed read URL from Supabase Storage bucket
   */
  static async getSignedReadUrl(bucket, storagePath, expiresIn = 86400) {
    if (!storagePath) return null;
    try {
      const db = getDB();
      const { data, error } = await db.storage.from(bucket).createSignedUrl(storagePath, expiresIn);
      if (error) {
        console.warn(`[ProjectMedia] Failed to generate signed URL for ${bucket}/${storagePath}:`, error.message);
        return null;
      }
      return data?.signedUrl || null;
    } catch (e) {
      console.warn(`[ProjectMedia] Exception generating signed URL for ${storagePath}:`, e.message);
      return null;
    }
  }

  /**
   * Generate signed upload URL for project media image
   */
  static async generateUploadUrl(projectId, filename, contentType = 'image/jpeg') {
    const db = getDB();
    const pId = parseInt(projectId, 10);

    const { data: project } = await db.from('projects').select('id, name').eq('id', pId).maybeSingle();
    if (!project) throw new AppError('Проект не найден', 404);

    const ext = filename.split('.').pop()?.toLowerCase();
    const allowed = ['jpg', 'jpeg', 'png', 'webp'];
    if (!allowed.includes(ext)) {
      throw new AppError('Разрешены только форматы изображений: JPG, JPEG, PNG, WebP', 400);
    }

    const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `projects/${pId}/media/${Date.now()}_${sanitized}`;
    const bucket = 'project-media';

    try {
      const { data, error } = await db.storage.from(bucket).createSignedUploadUrl(storagePath);
      if (error) {
        return {
          uploadUrl: `/api/storage/mock-upload/${storagePath}`,
          signedUploadUrl: `/api/storage/mock-upload/${storagePath}`,
          storagePath,
          storage_path: storagePath,
          token: 'mock-token'
        };
      }
      return {
        uploadUrl: data.signedUrl,
        signedUploadUrl: data.signedUrl,
        storagePath: data.path || storagePath,
        storage_path: data.path || storagePath,
        token: data.token
      };
    } catch (err) {
      return {
        uploadUrl: `/api/storage/mock-upload/${storagePath}`,
        signedUploadUrl: `/api/storage/mock-upload/${storagePath}`,
        storagePath,
        storage_path: storagePath,
        token: 'mock-token'
      };
    }
  }

  /**
   * Find all media for a project
   */
  static async findByProjectId(projectId, filters = {}) {
    const db = getDB();
    const pId = parseInt(projectId, 10);

    let query = db.from('project_media')
      .select('*')
      .eq('project_id', pId)
      .order('is_cover', { ascending: false })
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });

    if (filters.category && filters.category !== 'ALL') {
      query = query.eq('category', filters.category);
    }
    if (filters.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active === 'true' || filters.is_active === true);
    }

    const { data, error } = await query;
    if (error) throw error;

    const items = await Promise.all((data || []).map(async (item) => {
      const imageUrl = await this.getSignedReadUrl('project-media', item.storage_path);
      return {
        ...item,
        url: imageUrl,
        image_url: imageUrl,
        thumbnail_url: imageUrl
      };
    }));

    return items;
  }

  /**
   * Find single media item by ID
   */
  static async findById(mediaId) {
    const db = getDB();
    const mId = parseInt(mediaId, 10);
    const { data, error } = await db.from('project_media').select('*, projects(id, name)').eq('id', mId).maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const imageUrl = await this.getSignedReadUrl('project-media', data.storage_path);
    return {
      ...data,
      url: imageUrl,
      image_url: imageUrl,
      thumbnail_url: imageUrl
    };
  }

  /**
   * Create new media item
   */
  static async create(projectId, data) {
    const db = getDB();
    const now = new Date().toISOString();
    const pId = parseInt(projectId, 10);

    const { data: project } = await db.from('projects').select('id').eq('id', pId).maybeSingle();
    if (!project) throw new AppError('Проект не найден', 404);

    // If marked as cover, unmark previous covers for this project
    if (data.is_cover) {
      await db.from('project_media').update({ is_cover: false, updated_at: now }).eq('project_id', pId);
    }

    const { data: created, error } = await db.from('project_media').insert([{
      project_id: pId,
      category: data.category,
      title: data.title.trim(),
      description: data.description ? data.description.trim() : null,
      storage_path: data.storage_path.trim(),
      mime_type: data.mime_type || 'image/jpeg',
      sort_order: data.sort_order || 0,
      is_cover: !!data.is_cover,
      is_active: data.is_active !== undefined ? !!data.is_active : true,
      metadata: data.metadata || {},
      created_at: now,
      updated_at: now
    }]).select().single();

    if (error) throw error;
    const imageUrl = await this.getSignedReadUrl('project-media', created.storage_path);
    return {
      ...created,
      url: imageUrl,
      image_url: imageUrl,
      thumbnail_url: imageUrl
    };
  }

  /**
   * Update media item
   */
  static async update(mediaId, data) {
    const db = getDB();
    const now = new Date().toISOString();
    const mId = parseInt(mediaId, 10);

    const existing = await this.findById(mId);
    if (!existing) throw new AppError('Медиафайл не найден', 404);

    if (data.is_cover && !existing.is_cover) {
      await db.from('project_media').update({ is_cover: false, updated_at: now }).eq('project_id', existing.project_id);
    }

    const { data: updated, error } = await db.from('project_media')
      .update({
        ...data,
        updated_at: now
      })
      .eq('id', mId)
      .select()
      .single();

    if (error) throw error;
    const imageUrl = await this.getSignedReadUrl('project-media', updated.storage_path);
    return {
      ...updated,
      url: imageUrl,
      image_url: imageUrl,
      thumbnail_url: imageUrl
    };
  }

  /**
   * Set media item as project cover
   */
  static async setCover(mediaId) {
    const db = getDB();
    const now = new Date().toISOString();
    const mId = parseInt(mediaId, 10);

    const existing = await this.findById(mId);
    if (!existing) throw new AppError('Медиафайл не найден', 404);

    // Unset all covers in this project
    await db.from('project_media').update({ is_cover: false, updated_at: now }).eq('project_id', existing.project_id);

    // Set this media as cover
    const { data: updated, error } = await db.from('project_media')
      .update({ is_cover: true, updated_at: now })
      .eq('id', mId)
      .select()
      .single();

    if (error) throw error;
    const imageUrl = await this.getSignedReadUrl('project-media', updated.storage_path);
    return {
      ...updated,
      url: imageUrl,
      image_url: imageUrl,
      thumbnail_url: imageUrl
    };
  }

  /**
   * Delete media item
   */
  static async delete(mediaId) {
    const db = getDB();
    const mId = parseInt(mediaId, 10);
    const { error } = await db.from('project_media').delete().eq('id', mId);
    if (error) throw error;
    return true;
  }
}
