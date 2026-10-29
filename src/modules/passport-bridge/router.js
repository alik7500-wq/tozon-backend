import { getFinanceBot } from '../telegram-finance/start.js';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { canScan, passportBridge } from './service.js';
const router=Router();
router.use((req,res,next)=>canScan(req.user)?next():res.status(403).json({message:'Нет прав на заполнение данных клиента'}));
router.use(rateLimit({windowMs:15*60000,limit:500,keyGenerator:req=>String(req.user.id)}));
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
const run=fn=>async(req,res,next)=>{try{res.json({data:await fn(req)});}catch(e){res.status(e.message==='PASSPORT_SESSION_EXPIRED'?410:503).json({message:'Сессия недоступна. Создайте новую или обратитесь к администратору.'});}};
router.post('/',rateLimit({windowMs:15*60000,limit:10,keyGenerator:req=>String(req.user.id)}),run(req=>passportBridge.create(req.user)));
router.get('/:id/images/:index',async(req,res)=>{
  try {
    if(!/^[0-3]$/.test(req.params.index))return res.sendStatus(404);
    const image=await passportBridge.image(req.params.id,req.user,Number(req.params.index),getFinanceBot().api);
    res.set({'Content-Type':image.mimeType,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}).send(image.buffer);
  } catch {res.status(404).json({message:'Фото недоступно. Создайте новую сессию.'});}
});
router.get('/:id',run(req=>passportBridge.status(req.params.id,req.user)));
router.post('/:id/approve',run(req=>passportBridge.approve(req.params.id,req.user)));
router.post('/:id/consume',run(req=>passportBridge.consume(req.params.id,req.user)));
router.delete('/:id',run(req=>passportBridge.cancel(req.params.id,req.user)));
export default router;
