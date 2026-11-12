import { it, expect, vi } from 'vitest';
vi.mock('../modules/integrations/instagram-live.repository.js',()=>({saveInstagramThread:vi.fn()}));
import { instagramWebhookMessages } from '../modules/integrations/instagram-webhook.processor.js';
const account='17841447499018452',now=Date.now();
const payload=event=>({entry:[{id:account,messaging:[{sender:{id:'123'},recipient:{id:account},timestamp:now,message:{mid:'mid',text:'Салом 😊'},...event}]}]});
it('normalizes signed inbound Unicode, attachments, and outgoing echoes',()=>{
 const a=instagramWebhookMessages(payload(),account,now)[0];expect(a.body.text_content).toBe('Салом 😊');expect(a.thread.contactId).toBe('123');expect(a.body.is_echo).toBe(false);
 const b=instagramWebhookMessages(payload({sender:{id:account},recipient:{id:'123'}}),account,now)[0];expect(b.body.is_echo).toBe(true);
 const c=instagramWebhookMessages(payload({message:{mid:'pic',attachments:[{type:'image',payload:{url:'https://scontent.cdninstagram.com/pic.jpg'}}]}}),account,now)[0];expect(c.body.attachments[0].type).toBe('image');
});
it('rejects foreign accounts/participants, ignores future events and non-message events',()=>{
 expect(()=>instagramWebhookMessages(payload(), '999',now)).toThrow('ACCOUNT_MISMATCH');
 expect(()=>instagramWebhookMessages(payload({recipient:{id:'999'}}),account,now)).toThrow('PARTICIPANT_MISMATCH');
 expect(instagramWebhookMessages(payload({timestamp:now+400000}),account,now)).toEqual([]);
 expect(instagramWebhookMessages(payload({message:undefined,read:{}}),account,now)).toEqual([]);
});
