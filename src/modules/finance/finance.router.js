import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({ success: true, message: 'finance router stub' });
});

export default router;

