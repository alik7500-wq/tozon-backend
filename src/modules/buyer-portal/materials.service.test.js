import {beforeEach,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import {BuyerMaterialsService,safePlanUrl,visibleDocuments} from './materials.service.js';
const png=Buffer.from([137,80,78,71,13,10,26,10,0]);
const doc={id:'doc1',kind:'CONTRACT',language:'tj',isSignedOriginal:true,storagePath:'deals/1/file.pdf',mime:'application/pdf',size:8,sha256:createHash('sha256').update('%PDF-1.7').digest('hex')};
let repo,storage,identity,service;
const raw=()=>({plan2d:'/layouts/own.png',plan3d:null,tour:{id:1,name:'Own tour',panoramas:[{id:1,name:'Room',storagePath:'projects/1/own.jpg',hotspots:[]}]},documents:[doc]});
beforeEach(()=>{
 vi.stubEnv('BUYER_PORTAL_URL','https://example.test/buyer');
 repo={materials:vi.fn(async()=>raw()),documentList:vi.fn(),createDocument:vi.fn(),publishDocument:vi.fn()};
 storage={download:vi.fn(async()=>Buffer.from('%PDF-1.7')),upload:vi.fn(),remove:vi.fn(async()=>{})};
 identity={repo:{deal:vi.fn(async()=>({id:1,lead_id:2,status:'SIGNED'}))},assertStaff:vi.fn()};
 service=new BuyerMaterialsService({repo,storage,identity,fetchFn:vi.fn(async()=>new Response(png,{headers:{'Content-Type':'image/png'}}))});
});
it('returns metadata only, no bucket paths, hashes or URLs',async()=>{
 const result=await service.manifest('101',1);expect(JSON.stringify(result)).not.toMatch(/storagePath|projects\/|deals\/|sha256|mime|https:/);
 expect(result.documents[0]).toMatchObject({id:'doc1',isSignedOriginal:true});
});
it('rejects foreign/unavailable contracts before touching storage',async()=>{
 repo.materials.mockResolvedValue(null);await expect(service.asset('202',{dealId:1,type:'DOCUMENT',id:'doc1'})).rejects.toThrow('BUYER_MATERIAL_UNAVAILABLE');expect(storage.download).not.toHaveBeenCalled();
});
it('will not open any arbitrary document/panorama, URL or bucket supplied by the customer',async()=>{
 for(const input of [{type:'DOCUMENT',id:'foreign'},{type:'PANORAMA',id:99},{type:'http://localhost'},{type:'../identity-documents'}])await expect(service.asset('101',{dealId:1,...input})).rejects.toThrow('BUYER_MATERIAL_UNAVAILABLE');
 expect(storage.download).not.toHaveBeenCalled();
});
it('validates the exact private original and detects replacement bytes',async()=>{
 const asset=await service.asset('101',{dealId:1,type:'DOCUMENT',id:'doc1'});expect(asset.mime).toBe('application/pdf');
 expect(storage.download).toHaveBeenCalledWith('buyer-documents','deals/1/file.pdf');
 storage.download.mockResolvedValue(Buffer.from('%PDF-BAD'));
 await expect(service.asset('101',{dealId:1,type:'DOCUMENT',id:'doc1'})).rejects.toThrow('BUYER_MATERIAL_UNAVAILABLE');
});
it('rechecks access/publication after downloading, so revoked files are not returned',async()=>{
 repo.materials.mockResolvedValueOnce(raw()).mockResolvedValueOnce(null);
 await expect(service.asset('101',{dealId:1,type:'DOCUMENT',id:'doc1'})).rejects.toThrow('BUYER_MATERIAL_UNAVAILABLE');
});
it('always uses the published panorama bucket, never drafts',async()=>{
 storage.download.mockResolvedValue(png);await service.asset('101',{dealId:1,type:'PANORAMA',id:1});
 expect(storage.download).toHaveBeenCalledWith('panoramas-360','projects/1/own.jpg');
});
it('only retrieves safe image sources and refuses HTML/SVG content',async()=>{
 expect((await service.asset('101',{dealId:1,type:'PLAN_2D'})).mime).toBe('image/png');
 service.fetchFn.mockResolvedValue(new Response('<svg onload=alert(1)>'));
 await expect(service.asset('101',{dealId:1,type:'PLAN_2D'})).rejects.toThrow('BUYER_MATERIAL_UNAVAILABLE');
});
it.each(['http://127.0.0.1/private','file:///etc/passwd','/layouts/../../secret.png','/layouts/%2e%2e/secret.png','https://evil.test/picture.png','https://res.cloudinary.com/other/image/upload/a.png'])('blocks SSRF/traversal: %s',url=>{
 expect(()=>safePlanUrl(url,{portalUrl:'https://example.test/buyer',cloud:'own'})).toThrow();
});
it('prefers an uploaded signed original to unsigned copies of the same contract/language',()=>{
 const rows=[{...doc,id:'unsigned',isSignedOriginal:false},doc,{...doc,id:'ru',language:'ru',isSignedOriginal:false},{...doc,id:'act',kind:'ACT',isSignedOriginal:false}];
 expect(visibleDocuments(rows).map(d=>d.id)).toEqual(['doc1','ru','act']);
});
it('allows manager upload only as a draft and requires leadership for publication',async()=>{
 await service.upload(1,{id:7,role:'SALES_MANAGER'},{title:'Original',kind:'CONTRACT',language:'tj',isSignedOriginal:'true'},{buffer:Buffer.from('%PDF-1.7')});
 const row=repo.createDocument.mock.calls[0][0];expect(row).not.toHaveProperty('status');expect(row.owner_lead_id).toBe(2);expect(row.storage_path).toMatch(/^deals\/1\//);
 await expect(service.publish(1,'doc1',{id:7,role:'SALES_MANAGER'},'PUBLISH')).rejects.toThrow('BUYER_ACCESS_DENIED');
 expect(repo.publishDocument).not.toHaveBeenCalled();
 await service.publish(1,'doc1',{id:1,role:'ADMIN'},'PUBLISH');expect(repo.publishDocument).toHaveBeenCalledWith(1,'doc1',2,1,'PUBLISH');
});
