import {it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({store:vi.fn(),authorize:vi.fn(),upload:vi.fn(),download:vi.fn(),remove:vi.fn(),fetch:vi.fn()}));
vi.mock('./workspace.documents.js',()=>({PRIVATE_BUCKET:'company-project-private',privateStorage:mocks.store}));
vi.mock('./company-projects.setup.js',()=>({setupRpc:mocks.authorize}));
import {checkProjectStorage} from './storage.self-test.js';
const project='a1d3af61-af16-4e42-9be1-e6dc645929b3';
beforeEach(()=>{
 vi.resetAllMocks();vi.stubEnv('NODE_ENV','test');vi.stubEnv('TEST_SUPABASE_URL','https://yaolkwbnhnacxxjpgiyu.supabase.co');vi.stubEnv('PROJECT_WORKSPACE_ENABLED','true');
 for(const k of ['PROJECT_WORKSPACE_DOCUMENTS_ENABLED','PROJECT_WORKSPACE_FILES_ENABLED','PROJECT_WORKSPACE_WRITES_ENABLED'])vi.stubEnv(k,'true');
 mocks.authorize.mockResolvedValue({});mocks.store.mockResolvedValue({upload:mocks.upload,download:mocks.download,remove:mocks.remove});
 let payload;mocks.upload.mockImplementation(async(path,b)=>{payload=b;return {data:{path}};});mocks.download.mockImplementation(async()=>({data:new Blob([payload])}));
 mocks.remove.mockImplementation(async()=>{mocks.download.mockResolvedValue({error:{statusCode:'404',message:'Object not found'}});return {data:[]};});
 mocks.fetch.mockResolvedValue({status:404,body:{cancel:vi.fn()}});vi.stubGlobal('fetch',mocks.fetch);
});
it('tests only its random diagnostic file, denies anonymous paths and verifies cleanup',async()=>{
 const r=await checkProjectStorage(3,project);expect(r).toMatchObject({upload:true,download:true,integrity:true,anonymous_denied:true,cleanup:true});
 expect(mocks.authorize).toHaveBeenCalledTimes(3);expect(mocks.store).toHaveBeenCalledWith(true);
 const path=mocks.upload.mock.calls[0][0];expect(path).toMatch(new RegExp(`^${project}/_diagnostics/[0-9a-f-]{36}\\.pdf$`));expect(mocks.remove).toHaveBeenCalledWith([path]);expect(mocks.upload.mock.calls[0][2].upsert).toBe(false);
 expect(mocks.fetch).toHaveBeenCalledTimes(2);for(const [url,options] of mocks.fetch.mock.calls){expect(url).toContain('https://yaolkwbnhnacxxjpgiyu.supabase.co/storage/v1/object/');expect(options.headers).toBeUndefined();expect(options.redirect).toBe('error');}
});
it('fails closed before storage when runtime, feature or current admin rights fail',async()=>{
 vi.stubEnv('TEST_SUPABASE_URL','https://production.supabase.co');await expect(checkProjectStorage(3,project)).rejects.toMatchObject({statusCode:503});expect(mocks.store).not.toHaveBeenCalled();
 vi.stubEnv('TEST_SUPABASE_URL','https://yaolkwbnhnacxxjpgiyu.supabase.co');vi.stubEnv('PROJECT_WORKSPACE_FILES_ENABLED','false');await expect(checkProjectStorage(3,project)).rejects.toMatchObject({statusCode:503});
 vi.stubEnv('PROJECT_WORKSPACE_FILES_ENABLED','true');mocks.authorize.mockRejectedValue(new Error('denied'));await expect(checkProjectStorage(3,project)).rejects.toThrow('denied');expect(mocks.store).not.toHaveBeenCalled();
});
it('cleans up even after uncertain upload, corrupted download or public exposure',async()=>{
 mocks.upload.mockResolvedValue({error:new Error('uncertain upload')});await expect(checkProjectStorage(3,project)).rejects.toThrow('uncertain upload');expect(mocks.remove).toHaveBeenCalledOnce();
});
it('refuses corrupted bytes and still deletes its own object',async()=>{
 mocks.download.mockResolvedValue({data:new Blob(['bad'])});await expect(checkProjectStorage(3,project)).rejects.toMatchObject({statusCode:503});expect(mocks.remove).toHaveBeenCalledOnce();
});
it.each([200,500])('does not pass anonymous checks on HTTP %s',async status=>{
 mocks.fetch.mockResolvedValue({status,body:{cancel:vi.fn()}});await expect(checkProjectStorage(3,project)).rejects.toMatchObject({statusCode:503});expect(mocks.remove).toHaveBeenCalledOnce();
});
it('does not report success if cleanup or its verification fails',async()=>{
 mocks.remove.mockResolvedValue({error:new Error('failed')});await expect(checkProjectStorage(3,project)).rejects.toMatchObject({statusCode:503});
 mocks.remove.mockResolvedValue({data:[]});await expect(checkProjectStorage(3,project)).rejects.toMatchObject({statusCode:503});
});
