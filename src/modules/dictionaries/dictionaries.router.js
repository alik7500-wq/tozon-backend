import { Router } from 'express';
import { 
  getDictionaryItems, 
  createDictionaryItem, 
  updateDictionaryItem, 
  deleteDictionaryItem 
} from './dictionaries.controller.js';

const router = Router();

router.get('/', getDictionaryItems);
router.post('/', createDictionaryItem);
router.put('/:id', updateDictionaryItem);
router.delete('/:id', deleteDictionaryItem);

export default router;
