import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ claim: vi.fn(), finish: vi.fn(), fail: vi.fn(), read: vi.fn(), decrypt: vi.fn() }));
vi.mock('../modules/integrations/meta-events.repository.js', () => ({ MetaEvents: mocks }));
vi.mock('../modules/integrations/meta-assets.client.js', () => ({ metaRead: mocks.read }));
vi.mock('../modules/integrations/social-token-crypto.js', () => ({ decryptSocialToken: mocks.decrypt }));
import { processMetaFormsOnce } from '../modules/integrations/meta-event-worker.js';
const event = { id: 'event-fixture', lease_token: 'lease-fixture', external_id: '41', encrypted_access_token: 'fixture-encrypted', payload: { leadgen_id: '101' } };
beforeEach(() => {
  for (const flag of ['META_SOURCE_ROUTING_ENABLED','META_SOURCE_INGEST_ENABLED','META_FORM_LEADS_ENABLED']) vi.stubEnv(flag, 'true');
  mocks.claim.mockResolvedValue([event]); mocks.decrypt.mockReturnValue('fixture-token');
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('Meta form worker', () => {
  it('does not claim jobs until lead creation is separately enabled', async () => {
    vi.stubEnv('META_FORM_LEADS_ENABLED', 'false'); await processMetaFormsOnce(); expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('retrieves the expected form and passes normalized data to atomic completion', async () => {
    mocks.read.mockResolvedValue({ id: '101', form_id: '41', field_data: [{ name: 'full_name', values: ['Fixture'] }, { name: 'phone_number', values: ['900123456'] }] });
    await processMetaFormsOnce();
    expect(mocks.read).toHaveBeenCalledWith('/101', 'fixture-token', { fields: 'id,form_id,field_data,created_time' });
    expect(mocks.finish).toHaveBeenCalledWith('event-fixture', 'lease-fixture', expect.objectContaining({ phone: '+992900123456', full_name: 'Fixture' }));
  });
  it('holds a form without a phone instead of creating fictitious contact data', async () => {
    mocks.read.mockResolvedValue({ id: '101', form_id: '41', field_data: [] }); await processMetaFormsOnce();
    expect(mocks.finish).not.toHaveBeenCalled(); expect(mocks.fail).toHaveBeenCalledWith('event-fixture', 'lease-fixture', 'PHONE_MISSING_OR_INVALID', true);
  });
  it('rejects another form without creating a lead', async () => {
    mocks.read.mockResolvedValue({ id: '101', form_id: '999', field_data: [] }); await processMetaFormsOnce();
    expect(mocks.finish).not.toHaveBeenCalled(); expect(mocks.fail).toHaveBeenCalledWith('event-fixture', 'lease-fixture', 'FORM_ID_MISMATCH', true);
  });
  it('records only a fixed error code when retrieval fails', async () => {
    mocks.read.mockRejectedValue(new Error('secret-token and private response')); await processMetaFormsOnce();
    expect(mocks.fail).toHaveBeenCalledWith('event-fixture', 'lease-fixture', 'META_FORM_RETRIEVAL_FAILED', false);
  });
});
