import { BuyerIdentityService } from './identity.service.js';
import { BuyerIdentityRepository } from './identity.repository.js';
import { PayomSmsProvider } from '../sms/sms.provider.js';
export const buyerIdentity = new BuyerIdentityService({
  repo:new BuyerIdentityRepository(),sms:new PayomSmsProvider(),
  botIdentity:async () => {
    const { getFinanceBot }=await import('../telegram-finance/start.js');
    return getFinanceBot().api.call('getMe');
  },
});
