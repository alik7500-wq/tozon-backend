import { z } from 'zod';

export const MEDIA_CATEGORIES = [
  'EXTERIOR',
  'COURTYARD',
  'MASTERPLAN',
  'ENTRANCE',
  'INTERIOR',
  'FLOOR_PLAN',
  'COMMERCIAL',
  'CONSTRUCTION',
  'OTHER'
];

export const createMediaSchema = z.object({
  category: z.enum(MEDIA_CATEGORIES),
  title: z.string().min(1, 'Название обязательно').max(200),
  description: z.string().max(2000).optional().nullable(),
  storage_path: z.string().min(1, 'storage_path обязателен'),
  mime_type: z.string().default('image/jpeg'),
  sort_order: z.number().int().default(0),
  is_cover: z.boolean().default(false),
  metadata: z.record(z.any()).optional().default({})
});

export const updateMediaSchema = z.object({
  category: z.enum(MEDIA_CATEGORIES).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  sort_order: z.number().int().optional(),
  is_cover: z.boolean().optional(),
  is_active: z.boolean().optional(),
  metadata: z.record(z.any()).optional()
});

export const uploadUrlSchema = z.object({
  projectId: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]),
  filename: z.string().min(1),
  fileSizeBytes: z.number().positive().max(20 * 1024 * 1024, 'Максимальный размер изображения — 20 МБ').optional(),
  fileSize: z.number().positive().max(20 * 1024 * 1024).optional(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/jpg']).default('image/jpeg')
});
