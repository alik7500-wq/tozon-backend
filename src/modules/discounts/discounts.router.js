import express from 'express';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { hasSection } from '../../middleware/sectionAccess.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { listSchemes,saveScheme,deleteScheme } from './discounts.repository.js';
const router=express.Router();
router.use(protect);
router.get('/',async(req,res,next)=>{try{
  if(!hasSection(req.user,'deals.view')&&!hasSection(req.user,'settings.view')) throw new AppError('Нет доступа к скидкам',403);
  const schemes=await listSchemes();
  res.json({status:'success',data:{schemes}});
}catch(e){next(e)}});
router.use(restrictTo('ADMIN'));
router.use((req,res,next)=>hasSection(req.user,'settings.view',true)?next():next(new AppError('Нет права настройки скидок',403)));
router.post('/',async(req,res,next)=>{try{res.status(201).json({status:'success',data:{scheme:await saveScheme(null,req.body)}})}catch(e){next(e)}});
router.put('/:id',async(req,res,next)=>{try{res.json({status:'success',data:{scheme:await saveScheme(req.params.id,req.body)}})}catch(e){next(e)}});
router.delete('/:id',async(req,res,next)=>{try{await deleteScheme(req.params.id);res.sendStatus(204)}catch(e){next(e)}});
export default router;
