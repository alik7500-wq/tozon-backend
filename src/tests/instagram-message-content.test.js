import {describe,it,expect} from 'vitest';
import {instagramMessageContent as content,instagramContentUrl as url,instagramMessagePreview as preview} from '../modules/integrations/instagram-message-content.js';
const cdn='https://scontent.cdninstagram.com/example';
describe('Instagram media projection',()=>{
 it('preserves emoji, symbols, Tajik and text exactly',()=>{
  const message='Салом 😊👍❤️ © № 1 — хонаҳо';expect(content({message}).text_content).toBe(message);
 });
 it('projects image, audio, video and file without leaking raw fields',()=>{
  const c=content({attachments:{data:[{image_data:{url:cdn},access_token:'secret'},{mime_type:'audio/mp4',file_url:cdn},{video_data:{url:cdn,preview_url:cdn}},{mime_type:'application/pdf',file_url:cdn,name:'Plan.pdf'}]}});
  expect(c.attachments.map(a=>a.type)).toEqual(['image','audio','video','file']);
  expect(c.attachments.every(a=>a.url===cdn)).toBe(true);expect(JSON.stringify(c)).not.toContain('secret');
 });
 it('retains a content label when media URL is missing or unsafe',()=>{
  const c=content({attachments:{data:[{mime_type:'image/gif',image_data:{url:'javascript:alert(1)'}}]}});
  expect(c.attachments[0]).toMatchObject({type:'image',url:null});expect(preview({attachments:{data:[{mime_type:'image/gif'}]}})).toBe('Фото / GIF');
 });
 it('handles sticker, story, shared publication and reactions',()=>{
  const c=content({sticker:cdn,story:{url:'https://www.instagram.com/stories/example/1/'},shares:{data:[{link:'https://www.instagram.com/p/example/',name:'Publication',picture:cdn}]},reactions:{data:[{reaction:'❤️'},{reaction:'❤️'},{reaction:'👍'}]}});
  expect(c.attachments[0].type).toBe('sticker');expect(c.shares.map(s=>s.type)).toEqual(['share','story']);expect(c.reactions).toEqual([{emoji:'❤️',count:2},{emoji:'👍',count:1}]);
 });
 it('distinguishes unavailable API content from unsupported events',()=>{
  expect(content({message:''})).toMatchObject({contentUnavailable:true,unsupported:false});
  expect(content({is_unsupported:true})).toMatchObject({contentUnavailable:true,unsupported:true});
  expect(preview({})).toBe('Содержимое недоступно в API Instagram');
 });
 it.each(['javascript:alert(1)','http://scontent.cdninstagram.com/a','https://evil.example/a','https://fbcdn.net.evil.example/a','https://user:password@fbcdn.net/a','https://fbcdn.net/a?access_token=secret','https://fbcdn.net/a?CLIENT_SECRET=secret'])('rejects unsafe media URLs %s',value=>expect(url(value,true)).toBeNull());
 it('permits ordinary external share links but never embeds them as media',()=>{
  expect(url('https://example.com/article')).toBe('https://example.com/article');expect(url('https://example.com/article',true)).toBeNull();
 });
});
