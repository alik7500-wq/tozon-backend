import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyMiniAppInitData } from './telegram-auth.js';
import { buyerEnabled, BuyerPortalError } from './identity.service.js';

export function createBuyerRouter(service, {enabled=buyerEnabled, botToken=()=>process.env.TELEGRAM_FINANCE_BOT_TOKEN}={}) {
  const router=Router();
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if (!enabled()) return res.sendStatus(404);
    next();
  });
  router.use(rateLimit({windowMs:60000,limit:30}));
  router.use((req,res,next)=>{
    try {
      const raw=req.get('X-Telegram-Init-Data');
      req.buyer=verifyMiniAppInitData(raw,botToken()); next();
    } catch { res.status(401).json({message:'INVALID_TELEGRAM_AUTH'}); }
  });
  router.use(rateLimit({windowMs:60000,limit:10,keyGenerator:req=>req.buyer.telegramUserId}));
  const run=fn=>async(req,res)=>{
    try { res.json({data:await fn(req)}); }
    catch(e) { res.status(e instanceof BuyerPortalError?e.statusCode:503).json({message:e instanceof BuyerPortalError?e.message:'BUYER_SERVICE_UNAVAILABLE'}); }
  };
  router.post('/otp',run(req=>service.requestCode(req.body?.token,req.buyer.telegramUserId)));
  router.post('/verify',run(req=>service.confirmCode(req.body?.challengeId,req.body?.code,req.buyer.telegramUserId)));
  // Deliberately returns only granted IDs until the financial projection is validated.
  router.get('/access',run(req=>service.contracts(req.buyer.telegramUserId)));
  return router;
}
