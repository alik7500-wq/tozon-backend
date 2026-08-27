import { z } from 'zod';

export const createSceneSchema = z.object({
  name: z.string().trim().min(1, 'Название сцены обязательно').max(255),
  building_id: z.number().int().positive().nullable().optional(),
  scene_type: z.enum(['MASTERPLAN', 'BUILDING', 'FLOOR', 'APARTMENT'], {
    errorMap: () => ({ message: 'scene_type должен быть MASTERPLAN, BUILDING, FLOOR или APARTMENT' })
  }),
  storage_path: z.string().trim().min(1, 'storage_path обязателен'),
  file_size_bytes: z.number().int().nonnegative().optional().default(0),
  version: z.number().int().positive().optional().default(1),
  is_active: z.boolean().optional().default(true),
  camera_config: z.record(z.any()).optional().default({ position: [30, 20, 30], target: [0, 0, 0], fov: 45 }),
  environment_config: z.record(z.any()).optional().default({ preset: 'city', exposure: 1.0, background_color: '#0f172a' }),
});

export const updateSceneSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  building_id: z.number().int().positive().nullable().optional(),
  scene_type: z.enum(['MASTERPLAN', 'BUILDING', 'FLOOR', 'APARTMENT']).optional(),
  storage_path: z.string().trim().min(1).optional(),
  file_size_bytes: z.number().int().nonnegative().optional(),
  version: z.number().int().positive().optional(),
  is_active: z.boolean().optional(),
  camera_config: z.record(z.any()).optional(),
  environment_config: z.record(z.any()).optional(),
});

export const createEntitySchema = z.object({
  mesh_key: z.string().trim().min(1, 'mesh_key обязателен').max(255),
  entity_type: z.enum(['BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI'], {
    errorMap: () => ({ message: 'entity_type должен быть BUILDING, SECTION, FLOOR, UNIT или POI' })
  }),
  entity_id: z.number().int().positive('entity_id должен быть положительным числом'),
  interaction_type: z.enum(['SELECT', 'HOVER_INFO', 'FOCUS', 'NONE']).optional().default('SELECT'),
  metadata: z.record(z.any()).optional().default({}),
});

export const updateEntitySchema = z.object({
  mesh_key: z.string().trim().min(1).max(255).optional(),
  entity_type: z.enum(['BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI']).optional(),
  entity_id: z.number().int().positive().optional(),
  interaction_type: z.enum(['SELECT', 'HOVER_INFO', 'FOCUS', 'NONE']).optional(),
  metadata: z.record(z.any()).optional(),
});

export const batchEntitiesSchema = z.object({
  entities: z.array(createEntitySchema).min(1, 'Массив entities не может быть пустым')
});

export const uploadUrl3DSchema = z.object({
  projectId: z.number().int().positive('projectId обязателен'),
  sceneType: z.enum(['MASTERPLAN', 'BUILDING', 'FLOOR', 'APARTMENT']).optional().default('BUILDING'),
  sceneId: z.number().int().positive().nullable().optional(),
  filename: z.string().trim().min(1, 'filename обязателен')
    .refine(fn => fn.toLowerCase().endsWith('.glb'), {
      message: 'Разрешены только 3D-файлы формата .glb'
    }),
  fileSizeBytes: z.number().int().positive().max(104857600, 'Максимальный размер 3D модели — 100 МБ')
});
