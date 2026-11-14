import { BuyerIdentityService } from './identity.service.js';
import { BuyerIdentityRepository } from './identity.repository.js';
import { PayomSmsProvider } from '../sms/sms.provider.js';
import { BuyerBot, buyerAppUrl } from './bot.js';
import {BuyerMaterialsService} from './materials.service.js';
import {buyerStorage} from './storage.js';
import {BuyerCommunicationsService} from './communications.service.js';
import {BuyerCommunicationsRepository} from './communications.repository.js';
import {BuyerNotificationWorker} from './notification-worker.js';
export const buyerBot = new BuyerBot({repo:new BuyerIdentityRepository()});
export const buyerIdentity = new BuyerIdentityService({
  repo:new BuyerIdentityRepository(),sms:new PayomSmsProvider(),
  botIdentity:async () => {
    buyerAppUrl(); // Fail before issuing a QR if Mini App URL has not been configured safely.
    const { getFinanceBot }=await import('../telegram-finance/start.js');
    return getFinanceBot().api.call('getMe');
  },
});
export const buyerMaterials=new BuyerMaterialsService({repo:new BuyerIdentityRepository(),identity:buyerIdentity,storage:buyerStorage});
const communicationsRepo=new BuyerCommunicationsRepository();
export const buyerCommunications=new BuyerCommunicationsService({repo:communicationsRepo,identity:buyerIdentity});
export const buyerNotifications=new BuyerNotificationWorker({repo:communicationsRepo,identity:buyerIdentity,api:{send:async(...args)=>{
 const {getFinanceBot}=await import('../telegram-finance/start.js');return getFinanceBot().api.send(...args);
}}});
