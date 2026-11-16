import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyMiniAppInitData } from './telegram-auth.js';
import { buyerEnabled, BuyerPortalError } from './identity.service.js';
import { generateBuyerPdf } from './pdf-generator.js';

export function createBuyerRouter(service, {enabled=buyerEnabled, botToken=()=>process.env.TELEGRAM_FINANCE_BOT_TOKEN,materials,communications}={}) {
  const router=Router();
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if (!enabled()) return res.sendStatus(404);
    next();
  });
  router.use(rateLimit({windowMs:60000,limit:300}));
  router.use((req,res,next)=>{
    try {
      const raw=req.get('X-Telegram-Init-Data');
      req.buyer=verifyMiniAppInitData(raw,botToken()); next();
    } catch { res.status(401).json({message:'INVALID_TELEGRAM_AUTH'}); }
  });
  router.use(rateLimit({windowMs:60000,limit:60,keyGenerator:req=>req.buyer.telegramUserId}));
  const otpLimit=rateLimit({windowMs:60000,limit:10,keyGenerator:req=>req.buyer.telegramUserId});
  const run=fn=>async(req,res)=>{
    try { res.json({data:await fn(req)}); }
    catch(e) { res.status(e instanceof BuyerPortalError?e.statusCode:503).json({message:e instanceof BuyerPortalError?e.message:'BUYER_SERVICE_UNAVAILABLE'}); }
  };
  router.post('/connect',otpLimit,run(req=>service.requestConnection(req.body?.token,req.buyer.telegramUserId)));
  router.post('/otp',otpLimit,run(req=>service.requestCode(req.body?.token,req.buyer.telegramUserId)));
  router.post('/verify',otpLimit,run(req=>service.confirmCode(req.body?.challengeId,req.body?.code,req.buyer.telegramUserId)));
  // Deliberately returns only granted IDs until the financial projection is validated.
  router.get('/access',run(req=>service.contracts(req.buyer.telegramUserId)));
  router.get('/contracts',run(req=>service.contractList(req.buyer.telegramUserId)));
  router.post('/contract',run(req=>service.contract(req.buyer.telegramUserId,req.body?.dealId)));
  router.patch('/preferences',run(req=>service.preferences(req.buyer.telegramUserId,req.body?.language)));
  router.get('/communication-settings',run(req=>communications.settings(req.buyer.telegramUserId)));
  router.patch('/communication-settings',run(req=>communications.saveSettings(req.buyer.telegramUserId,req.body||{})));
  router.get('/notices',run(req=>communications.notices(req.buyer.telegramUserId)));
  router.post('/notice-read',run(req=>communications.read(req.buyer.telegramUserId,req.body?.id)));
  router.post('/inquiries',run(req=>communications.history(req.buyer.telegramUserId,req.body?.dealId)));
  router.post('/contact',rateLimit({windowMs:60000,limit:5,keyGenerator:req=>req.buyer.telegramUserId}),run(req=>communications.contact(req.buyer.telegramUserId,req.body||{})));
  router.post('/materials',run(req=>materials.manifest(req.buyer.telegramUserId,req.body?.dealId)));
  router.post('/construction',run(req=>materials.construction(req.buyer.telegramUserId,req.body?.dealId)));
  router.post('/pdf',async(req,res)=>{
    try{
      const {dealId,kind,paymentId,language}=req.body||{};
      if(!['CONTRACT','SCHEDULE','RECEIPT'].includes(kind))throw new BuyerPortalError('BUYER_MATERIAL_UNAVAILABLE',400);
      if(kind==='RECEIPT'&&!/^[1-9]\d{0,12}$/.test(String(paymentId||'')))throw new BuyerPortalError('BUYER_MATERIAL_UNAVAILABLE',404);
      const contract=await service.contract(req.buyer.telegramUserId,dealId);
      if(kind==='SCHEDULE'&&contract.archived)throw new BuyerPortalError('BUYER_MATERIAL_UNAVAILABLE',404);
      const pdf=await generateBuyerPdf(contract,{kind,paymentId,language:language==='ru'?'ru':'tj'});
      if(!pdf)throw new BuyerPortalError('BUYER_MATERIAL_UNAVAILABLE',404);
      const safeName=String(pdf.filename||'TOZON.pdf').replace(/[^A-Za-z0-9_.-]/g,'_');
      res.set({'Content-Type':pdf.mime,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Disposition':`attachment; filename="${safeName}"`});
      res.send(pdf.buffer);
    }catch(e){res.status(e instanceof BuyerPortalError?e.statusCode:503).json({message:e instanceof BuyerPortalError?e.message:'BUYER_MATERIAL_UNAVAILABLE'});}
  });
  router.post('/asset',async(req,res)=>{
    try{const asset=await materials.asset(req.buyer.telegramUserId,req.body||{});
      res.set({'Content-Type':asset.mime,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
      if(asset.filename)res.set('Content-Disposition',`attachment; filename="${asset.filename}"`);
      res.send(asset.buffer);
    }catch(e){res.status(e instanceof BuyerPortalError?e.statusCode:503).json({message:e instanceof BuyerPortalError?e.message:'BUYER_MATERIAL_UNAVAILABLE'});}
  });
  return router;
}
