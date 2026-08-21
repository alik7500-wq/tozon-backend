import express from 'express';
import multer from 'multer';
import { uploadImage } from './upload.controller.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/', upload.single('image'), uploadImage);

export default router;
