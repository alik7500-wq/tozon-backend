import { getServiceDB } from '../../db/connection.js';

const checked = result => { if (result.error) throw result.error; return result.data; };
export class TelegramFinanceRepository {
  constructor(db = getServiceDB()) { this.db = db; }
  async subscribers() {
    return checked(await this.db.from('telegram_finance_subscribers').select('*').order('created_at'));
  }
  async find(id) {
    return checked(await this.db.from('telegram_finance_subscribers').select('*').eq('telegram_id', String(id)).maybeSingle());
  }
  async register(user) {
    const existing = await this.find(user.id);
    const fields = { display_name: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 100), username: (user.username || '').slice(0, 64), last_seen_at: new Date().toISOString() };
    if (existing) return checked(await this.db.from('telegram_finance_subscribers').update(fields).eq('telegram_id', String(user.id)).select().single());
    return checked(await this.db.from('telegram_finance_subscribers').upsert({ telegram_id: String(user.id), ...fields }, { onConflict: 'telegram_id', ignoreDuplicates: true }).select().maybeSingle());
  }
  async setAccess(id, slot, actor) {
    return checked(await this.db.from('telegram_finance_subscribers').update({ slot: slot || null, status: slot ? 'APPROVED' : 'REVOKED', approved_by: actor, approved_at: new Date().toISOString() }).eq('telegram_id', id).select().single());
  }
  async snapshot() { return checked(await this.db.rpc('telegram_finance_snapshot')); }
  async cashDesks() { return checked(await this.db.from('dictionaries').select('id,name,code').eq('type','CASH_DESK').eq('is_active',true).order('sort_order')); }
  async crmUsers() { return checked(await this.db.from('users').select('id,name').eq('is_active',true).order('name')); }
  async cashAccess(id, fields) { return checked(await this.db.from('telegram_finance_subscribers').update(fields).eq('telegram_id',id).select().single()); }
  async session(id) { return checked(await this.db.from('telegram_finance_sessions').select('data').eq('telegram_id',String(id)).maybeSingle())?.data || null; }
  async saveSession(id,data) { return checked(await this.db.from('telegram_finance_sessions').upsert({telegram_id:String(id),data,updated_at:new Date().toISOString()})); }
  async clearSession(id) { return checked(await this.db.from('telegram_finance_sessions').delete().eq('telegram_id',String(id))); }
  async draft(user,desk,payload) { return checked(await this.db.from('telegram_finance_expense_drafts').insert({telegram_id:user.telegram_id,cash_desk_id:desk,payload}).select().single()); }
  async cancelDraft(id,user) { return checked(await this.db.from('telegram_finance_expense_drafts').update({status:'CANCELLED'}).eq('id',id).eq('telegram_id',user).eq('status','DRAFT')); }
  async postExpense(user,id) { return checked(await this.db.rpc('telegram_finance_post_expense',{p_telegram_id:user,p_draft_id:id})); }
  async ledger(user,kind,desk,offset=0) {
    if (user.status!=='APPROVED' || (user.slot!=='AKMALKHON' && (!user.cash_desk_id || (desk && desk!==user.cash_desk_id)))) throw new Error('CASH_ACCESS_DENIED');
    const income=kind==='income';
    let q=this.db.from(income?'payments':'expenses').select(income?'id,reference,document_number,payment_date,amount_minor,currency,payer_name,comment,status,cash_desk_id':'id,reference,document_number,expense_date,amount_minor,currency,recipient,category,description,status,cash_desk_id');
    const scope=user.slot==='AKMALKHON'?desk:user.cash_desk_id;
    if(scope)q=q.eq('cash_desk_id',scope);
    return checked(await q.order(income?'payment_date':'expense_date',{ascending:false}).order('id',{ascending:false}).range(offset,offset+9));
  }
  async enqueue(update) {
    const result = await this.db.from('telegram_finance_updates').insert({ update_id: update.update_id, payload: update });
    if (result.error?.code === '23505') return;
    checked(result);
  }
  async pending() { return checked(await this.db.from('telegram_finance_updates').select('update_id,payload').eq('status', 'PENDING').order('update_id').limit(20)); }
  async updateStatus(id, status) { return checked(await this.db.from('telegram_finance_updates').update({ status }).eq('update_id', id)); }
  async claimLease(worker) { return checked(await this.db.rpc('telegram_finance_claim_worker', { p_worker: worker })); }
  async state() { return checked(await this.db.from('telegram_finance_state').select('*').eq('id', 1).single()); }
  async offset(worker, offset) { return checked(await this.db.from('telegram_finance_state').update({ update_offset: offset }).eq('id', 1).eq('worker_id', worker).select()); }
  async release(worker) { return checked(await this.db.from('telegram_finance_state').update({ lease_until: new Date(0).toISOString() }).eq('id', 1).eq('worker_id', worker)); }
  async beginDelivery(id, date) {
    const result = await this.db.from('telegram_finance_deliveries').insert({ telegram_id: id, report_date: date, status: 'PROCESSING' }).select().single();
    if (result.error?.code === '23505') return null;
    return checked(result);
  }
  async finishDelivery(id, date, status) { return checked(await this.db.from('telegram_finance_deliveries').update({ status, finished_at: new Date().toISOString() }).eq('telegram_id', id).eq('report_date', date)); }
  async deliveries(date) {
    let query = this.db.from('telegram_finance_deliveries').select('telegram_id,report_date,status,finished_at').order('report_date', { ascending: false }).limit(30);
    if (date) query = query.eq('report_date', date);
    return checked(await query);
  }
}
