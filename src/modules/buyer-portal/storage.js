import {getServiceDB} from '../../db/connection.js';
const checked=r=>{if(r.error)throw new Error('BUYER_STORAGE_UNAVAILABLE');return r.data;};
export const buyerStorage={
 async download(bucket,path){const blob=checked(await getServiceDB().storage.from(bucket).download(path));if(blob.size>20*1024*1024)throw new Error('BUYER_STORAGE_UNAVAILABLE');return Buffer.from(await blob.arrayBuffer());},
 async upload(path,buffer,mime){checked(await getServiceDB().storage.from('buyer-documents').upload(path,buffer,{contentType:mime,upsert:false}));},
 async remove(path){checked(await getServiceDB().storage.from('buyer-documents').remove([path]));}
};
