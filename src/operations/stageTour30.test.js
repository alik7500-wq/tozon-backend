import { describe,it,expect,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { assertTour30Context,verifyTour30File,copyVerifiedFile } from './stageTour30.js';
import { TOUR30_FILES } from './tour30Manifest.js';
const context=()=>({tour:{id:30,project_id:3,entity_type:'UNIT',entity_id:83,is_active:false},panoramas:TOUR30_FILES.map(f=>({id:f.id,tour_id:30,name:f.name,storage_path:f.path,thumbnail_path:null})),hotspots:[[55,56],[55,57],[55,59],[56,55],[57,55],[57,58],[58,57],[59,55]].map(([a,b])=>({panorama_id:a,target_panorama_id:b,hotspot_type:'NAVIGATION'}))});
const jpeg=Buffer.from('ffd8ffc000070810002000ffd9','hex');
const entry={id:58,path:'projects/3/360/30/test.jpg',size:jpeg.length,sha256:createHash('sha256').update(jpeg).digest('hex')};
function storage({exists=false,source=jpeg,uploadError=null}={}) {
 const upload=vi.fn().mockResolvedValue({error:uploadError});
 return {upload,from:bucket=>bucket==='panoramas-360-drafts'?{download:async()=>({data:new Blob([source])})}:{list:async()=>({data:exists?[{name:'test.jpg'}]:[]}),upload}};
}
describe('bounded tour 30 staging',()=>{
 it('accepts only the exact inactive unit and five file manifest',()=>expect(()=>assertTour30Context(context())).not.toThrow());
 it.each([{id:31},{project_id:4},{entity_id:84},{is_active:true}])('rejects wrong scope/state %j',patch=>{const c=context();Object.assign(c.tour,patch);expect(()=>assertTour30Context(c)).toThrow('SCOPE');});
 it('rejects changed files',()=>{const c=context();c.panoramas[0].storage_path='another.jpg';expect(()=>assertTour30Context(c)).toThrow('MANIFEST');});
 it('rejects extra room',()=>{const c=context();c.panoramas.push({...c.panoramas[0],id:60});expect(()=>assertTour30Context(c)).toThrow('MANIFEST');});
 it('rejects a direct corridor kitchen link',()=>{const c=context();c.hotspots[0].target_panorama_id=58;expect(()=>assertTour30Context(c)).toThrow('NAVIGATION');});
 it('rejects corrupt bytes',()=>expect(()=>verifyTour30File(Buffer.from('corrupt'),entry)).toThrow('CHECKSUM'));
 it('verifies JPEG dimensions',()=>expect(()=>verifyTour30File(jpeg,entry)).not.toThrow());
 it('uploads without overwriting and checks anonymous reads',async()=>{const s=storage();const read=vi.fn().mockResolvedValue(jpeg);const r=await copyVerifiedFile(s,entry,read);expect(s.upload).toHaveBeenCalledWith(entry.path,expect.any(Buffer),expect.objectContaining({upsert:false}));expect(r.public_read_verified).toBe(true);});
 it('checks an existing destination without writing',async()=>{const s=storage({exists:true});await copyVerifiedFile(s,entry,async()=>jpeg);expect(s.upload).not.toHaveBeenCalled();});
 it('rejects a mismatched existing destination without overwrite',async()=>{const s=storage({exists:true});await expect(copyVerifiedFile(s,entry,async()=>Buffer.from('wrong'))).rejects.toThrow('CHECKSUM');expect(s.upload).not.toHaveBeenCalled();});
 it('rejects a corrupt source before uploading',async()=>{const s=storage({source:Buffer.from('wrong')});await expect(copyVerifiedFile(s,entry,async()=>jpeg)).rejects.toThrow('CHECKSUM');expect(s.upload).not.toHaveBeenCalled();});
 it('does not mask upload failures',async()=>{const s=storage({uploadError:{message:'failed'}});await expect(copyVerifiedFile(s,entry,async()=>jpeg)).rejects.toThrow('UPLOAD');});
 it('rejects any path outside this tour',async()=>{const s=storage();await expect(copyVerifiedFile(s,{...entry,path:'projects/3/360/31/test.jpg'},async()=>jpeg)).rejects.toThrow('INVALID_PATH');expect(s.upload).not.toHaveBeenCalled();});
});
