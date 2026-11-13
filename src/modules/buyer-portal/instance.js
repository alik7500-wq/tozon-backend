import { BuyerIdentityService } from './identity.service.js';
import { BuyerIdentityRepository } from './identity.repository.js';
import { PayomSmsProvider } from '../sms/sms.provider.js';
import { BuyerBot, buyerAppUrl } from './bot.js';
export const buyerBot = new BuyerBot({repo:new BuyerIdentityRepository()});
export const buyerIdentity = new BuyerIdentityService({
  repo:new BuyerIdentityRepository(),sms:new PayomSmsProvider(),
  botIdentity:async () => {
    buyerAppUrl(); // Fail before issuing a QR if Mini App URL has not been configured safely.
    const { getFinanceBot }=await import('../telegram-finance/start.js');
    return getFinanceBot().api.call('getMe');
  },
});
