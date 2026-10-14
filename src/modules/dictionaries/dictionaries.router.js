import { Router } from 'express';
import { 
  getDictionaryItems, 
  createDictionaryItem, 
  updateDictionaryItem, 
  deleteDictionaryItem 
} from './dictionaries.controller.js';

import { protect, protectOptional } from '../../middleware/auth.middleware.js';
import { resolveCashDeskAccess } from '../../middleware/cashDeskAuth.middleware.js';

const router = Router();

router.get('/', protectOptional, resolveCashDeskAccess, getDictionaryItems);
router.post('/', protect, createDictionaryItem);
router.put('/:id', protect, updateDictionaryItem);
router.delete('/:id', protect, deleteDictionaryItem);

export default router;

