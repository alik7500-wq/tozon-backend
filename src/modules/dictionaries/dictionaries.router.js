import { Router } from 'express';
import { 
  getDictionaryItems, 
  createDictionaryItem, 
  updateDictionaryItem, 
  deleteDictionaryItem 
} from './dictionaries.controller.js';

import { protectOptional } from '../../middleware/auth.middleware.js';
import { resolveCashDeskAccess } from '../../middleware/cashDeskAuth.middleware.js';

const router = Router();

router.get('/', protectOptional, resolveCashDeskAccess, getDictionaryItems);
router.post('/', createDictionaryItem);
router.put('/:id', updateDictionaryItem);
router.delete('/:id', deleteDictionaryItem);

export default router;
