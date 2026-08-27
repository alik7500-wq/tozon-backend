import { z } from 'zod';

export const createTourSchema = z.object({
  name: z.string().trim().min(1, 'Название тура обязательно').max(255),
  tour_type: z.enum(['PROJECT', 'BUILDING', 'FLOOR', 'UNIT', 'SHOWROOM', 'COURTYARD'], {
    errorMap: () => ({ message: 'tour_type должен быть PROJECT, BUILDING, FLOOR, UNIT, SHOWROOM или COURTYARD' })
  }),
  entity_type: z.enum(['BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI']).nullable().optional(),
  entity_id: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional().default(true),
});

export const updateTourSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  tour_type: z.enum(['PROJECT', 'BUILDING', 'FLOOR', 'UNIT', 'SHOWROOM', 'COURTYARD']).optional(),
  entity_type: z.enum(['BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI']).nullable().optional(),
  entity_id: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
});

export const createPanoramaSchema = z.object({
  name: z.string().trim().min(1, 'Название панорамы обязательно').max(255),
  storage_path: z.string().trim().min(1, 'storage_path обязателен'),
  thumbnail_path: z.string().trim().nullable().optional(),
  entity_type: z.enum(['BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI']).nullable().optional(),
  entity_id: z.number().int().positive().nullable().optional(),
  initial_yaw: z.number().min(-360).max(360).optional().default(0),
  initial_pitch: z.number().min(-90).max(90).optional().default(0),
  initial_fov: z.number().min(30).max(120).optional().default(75),
  sort_order: z.number().int().optional().default(0),
});

export const updatePanoramaSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  storage_path: z.string().trim().min(1).optional(),
  thumbnail_path: z.string().trim().nullable().optional(),
  entity_type: z.enum(['BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI']).nullable().optional(),
  entity_id: z.number().int().positive().nullable().optional(),
  initial_yaw: z.number().min(-360).max(360).optional(),
  initial_pitch: z.number().min(-90).max(90).optional(),
  initial_fov: z.number().min(30).max(120).optional(),
  sort_order: z.number().int().optional(),
});

export const createHotspotSchema = z.object({
  hotspot_type: z.enum(['NAVIGATION', 'UNIT', 'INFO', 'BUILDING', 'FLOOR', 'EXIT'], {
    errorMap: () => ({ message: 'hotspot_type должен быть NAVIGATION, UNIT, INFO, BUILDING, FLOOR или EXIT' })
  }),
  yaw: z.number().min(-360, 'yaw должен быть от -360 до 360').max(360),
  pitch: z.number().min(-90, 'pitch должен быть от -90 до 90').max(90),
  label: z.string().trim().max(255).nullable().optional(),
  target_panorama_id: z.number().int().positive().nullable().optional(),
  target_entity_type: z.enum(['BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI']).nullable().optional(),
  target_entity_id: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.any()).optional().default({}),
});

export const updateHotspotSchema = z.object({
  hotspot_type: z.enum(['NAVIGATION', 'UNIT', 'INFO', 'BUILDING', 'FLOOR', 'EXIT']).optional(),
  yaw: z.number().min(-360).max(360).optional(),
  pitch: z.number().min(-90).max(90).optional(),
  label: z.string().trim().max(255).nullable().optional(),
  target_panorama_id: z.number().int().positive().nullable().optional(),
  target_entity_type: z.enum(['BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI']).nullable().optional(),
  target_entity_id: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

export const uploadUrl360Schema = z.object({
  projectId: z.number().int().positive('projectId обязателен'),
  tourId: z.number().int().positive().nullable().optional(),
  filename: z.string().trim().min(1, 'filename обязателен')
    .refine(fn => {
      const lower = fn.toLowerCase();
      return lower.endsWith('.webp') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png');
    }, {
      message: 'Разрешены только изображения формата .webp, .jpg, .jpeg или .png'
    }),
  fileSizeBytes: z.number().int().positive().max(52428800, 'Максимальный размер панорамы — 50 МБ')
});
