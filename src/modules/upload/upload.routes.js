import express from 'express';
import multer from 'multer';
import { protect } from '../../middleware/auth.middleware.js';
import { uploadImage } from './upload.controller.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/', protect, upload.single('image'), uploadImage);

export default router;

