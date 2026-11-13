import { beforeEach, describe, it, expect, vi } from 'vitest';
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import { BuyerIdentityService, registeredPhone, otpDigest } from './identity.service.js';

const secret='test-only-secret-at-least-32-characters';
const staff={id:7,role:'SALES_MANAGER',is_active:true};
const deal={id:1,lead_id:2,status:'SIGNED',responsible_user_id:7,leads:{phone:'+992900000001'}};
let service,repo,sms,botIdentity;
beforeEach(()=>{
  repo={deal:vi.fn(async()=>deal),createInvite:vi.fn(async()=>({id:'invite',expires_at:'2026-11-13T00:15:00.000Z'})),
    prepare:vi.fn(async()=>({status:'PREPARED',phone:deal.leads.phone})),delivered:vi.fn(),deliveryFailed:vi.fn(),
    confirm:vi.fn(async()=>({status:'VERIFIED'})),access:vi.fn(async()=>[{deal_id:1}]),unlink:vi.fn()};
  sms={sendSms:vi.fn(async()=>({success:true,isMock:false}))};
  botIdentity=vi.fn(async()=>({username:'ActualConfiguredBot'}));
  service=new BuyerIdentityService({repo,sms,botIdentity,otpSecret:()=>secret,clock:()=>new Date('2026-11-13T00:00:00Z')});
});
describe('buyer invitations',()=>{
  it('creates an opaque link to the actual bot; stores no raw token',async()=>{
    const result=await service.createInvite(1,staff);
    expect(result.url).toMatch(/^https:\/\/t.me\/ActualConfiguredBot\?start=buyer_[A-Za-z0-9_-]{43}$/);
    expect(repo.createInvite.mock.calls[0][0]).toMatchObject({deal_id:1,lead_id:2,created_by:7});
    expect(result.expiresAt).toBe('2026-11-13T00:15:00.000Z');
    expect(JSON.stringify(repo.createInvite.mock.calls)).not.toContain(result.url.split('buyer_')[1]);
  });
  it.each([
    {...staff,id:8}, {...staff,is_active:false}, {...staff,role:'CASHIER'},
    {...staff,permissions:['access.v2','deals.view']},
  ])('denies unassigned, inactive, finance-only or read-only employees',async user=>{
    await expect(service.createInvite(1,user)).rejects.toThrow('BUYER_ACCESS_DENIED');
    expect(repo.createInvite).not.toHaveBeenCalled();
  });
  it('requires a signed contract and a registered usable phone',async()=>{
    repo.deal.mockResolvedValueOnce({...deal,status:'RESERVED'});
    await expect(service.createInvite(1,staff)).rejects.toThrow('BUYER_CONTRACT_UNAVAILABLE');
    repo.deal.mockResolvedValueOnce({...deal,leads:{phone:null}});
    await expect(service.createInvite(1,staff)).rejects.toThrow('BUYER_PHONE_REQUIRES_STAFF_VERIFICATION');
    expect(repo.createInvite).not.toHaveBeenCalled();
  });
  it('requires OTP configuration before creating an invitation',async()=>{
    service.otpSecret=()=>'';
    await expect(service.createInvite(1,staff)).rejects.toThrow('BUYER_OTP_NOT_CONFIGURED');
    expect(repo.createInvite).not.toHaveBeenCalled();
  });
  it('reserves global unlinking for leadership with write access',async()=>{
    await expect(service.unlink(1,staff)).rejects.toThrow('BUYER_ACCESS_DENIED');
    await expect(service.unlink(1,{id:1,is_active:true,role:'DIRECTOR',permissions:['access.v2','deals.view']})).rejects.toThrow('BUYER_ACCESS_DENIED');
    expect(repo.unlink).not.toHaveBeenCalled();
    await expect(service.unlink(1,{id:1,is_active:true,role:'ADMIN'})).resolves.toEqual({unlinked:true});
    expect(repo.unlink).toHaveBeenCalledWith(2,1);
  });
});
describe('buyer OTP service',()=>{
  it('sends only to CRM phone and returns no code or raw phone',async()=>{
    const result=await service.requestCode('a'.repeat(43),'101');
    const {id,codeHash}=repo.prepare.mock.calls[0][0];
    const sent=sms.sendSms.mock.calls[0][0];
    const code=sent.text.match(/\b\d{6}\b/)[0];
    expect(sent.phone).toBe(deal.leads.phone);
    expect(codeHash).toBe(otpDigest(secret,id,'101',code));
    expect(JSON.stringify(result)).not.toContain(code);
    expect(result).toMatchObject({challengeId:id,maskedPhone:'+992•••••0001'});
    expect(repo.delivered).toHaveBeenCalledWith(id);
  });
  it.each([{success:true,isMock:true},{success:true},{success:false,isMock:false}])('rejects mock, ambiguous and failed delivery',async outcome=>{
    sms.sendSms.mockResolvedValue(outcome);
    await expect(service.requestCode('a'.repeat(43),'101')).rejects.toThrow('BUYER_SMS_UNAVAILABLE');
    expect(repo.delivered).not.toHaveBeenCalled(); expect(repo.deliveryFailed).toHaveBeenCalledOnce();
  });
  it('sanitizes provider exceptions',async()=>{
    sms.sendSms.mockRejectedValue(new Error('secret-token +992900000001'));
    await expect(service.requestCode('a'.repeat(43),'101')).rejects.toThrow('BUYER_SMS_UNAVAILABLE');
  });
  it('does not send SMS when QR expires or throttles',async()=>{
    repo.prepare.mockResolvedValueOnce({status:'UNAVAILABLE'}).mockResolvedValueOnce({status:'RATE_LIMITED'});
    await expect(service.requestCode('a'.repeat(43),'101')).rejects.toThrow('BUYER_INVITE_UNAVAILABLE');
    await expect(service.requestCode('a'.repeat(43),'101')).rejects.toThrow('BUYER_OTP_RATE_LIMITED');
    expect(sms.sendSms).not.toHaveBeenCalled();
  });
  it('passes the authenticated Telegram identity, not a customer-supplied lead',async()=>{
    const id='12345678-1234-4123-8123-123456789012';
    await expect(service.confirmCode(id,'012345','101')).resolves.toEqual({verified:true});
    expect(repo.confirm).toHaveBeenCalledWith({id,telegramId:'101',codeHash:otpDigest(secret,id,'101','012345')});
  });
  it('does not return success for invalid codes or rebind conflicts',async()=>{
    const id='12345678-1234-4123-8123-123456789012';
    repo.confirm.mockResolvedValueOnce({status:'INVALID_CODE'}).mockResolvedValueOnce({status:'STAFF_REVIEW_REQUIRED'});
    await expect(service.confirmCode(id,'123456','101')).rejects.toThrow('BUYER_CODE_INVALID');
    await expect(service.confirmCode(id,'123456','101')).rejects.toThrow('BUYER_BINDING_REQUIRES_STAFF_REVIEW');
  });
  it('keeps OTP hashes scoped to challenge and Telegram',()=>{
    expect(otpDigest(secret,'one','101','123456')).not.toBe(otpDigest(secret,'two','101','123456'));
    expect(otpDigest(secret,'one','101','123456')).not.toBe(otpDigest(secret,'one','202','123456'));
  });
  it('normalizes only explicitly supported registered phones',()=>{
    expect(registeredPhone('90 000 00 01')).toBe('+992900000001');
    expect(registeredPhone('+992 (90) 000-00-01')).toBe('+992900000001');
    for(const phone of [null,'','call me','+79991234567']) expect(registeredPhone(phone)).toBeNull();
  });
});
