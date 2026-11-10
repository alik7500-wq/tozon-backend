import { getServiceDB } from '../../db/connection.js';
const check = result => { if (result.error) throw new Error('META_EVENT_STORAGE_UNAVAILABLE'); return result.data; };
export const MetaEvents = {
  async enqueue(events) { return check(await getServiceDB().rpc('enqueue_meta_source_events', { p_events: events })); },
  async list(ownerId, projectId = null) {
    const db = getServiceDB();
    const connection = check(await db.from('meta_source_connections').select('id').eq('owner_user_id', String(ownerId)).maybeSingle());
    if (!connection) return [];
    let query = db.from('meta_source_events')
      .select('id,source_id,project_id,channel,payload,status,lead_id,error_code,received_at,projects(name),meta_project_sources(name)')
      .eq('connection_id', connection.id).order('received_at', { ascending: false }).limit(100);
    if (projectId) query = query.eq('project_id', projectId);
    return check(await query) || [];
  },
  async assign(ownerId, eventId, expectedProjectId) {
    return check(await getServiceDB().rpc('assign_meta_source_event', { p_owner: String(ownerId), p_event: eventId, p_expected_project: expectedProjectId }));
  },
  async claim() { return check(await getServiceDB().rpc('claim_meta_form_events', { p_limit: 5 })) || []; },
  async finish(eventId, lease, form) {
    return check(await getServiceDB().rpc('complete_meta_form_event', { p_event: eventId, p_lease: lease, p_form: form }));
  },
  async fail(eventId, lease, code, review = false) {
    return check(await getServiceDB().rpc('fail_meta_form_event', {
      p_event: eventId, p_lease: lease, p_code: code, p_review: review
    }));
  }
};
