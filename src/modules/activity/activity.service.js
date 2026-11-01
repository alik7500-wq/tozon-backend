import { getServiceDB } from '../../db/connection.js';
export const SECTION_LABELS = { '/':'Обзор', '/leads':'Лиды', '/clients':'Клиенты', '/deals':'Сделки', '/projects':'Объекты ЖК', '/units':'Квартиры', '/apartments':'Квартиры', '/payments':'Платежи', '/finance':'Финансы', '/costs':'Себестоимость', '/construction':'Строительный учёт', '/analytics':'Аналитика', '/tasks':'Задачи', '/users':'Пользователи', '/settings':'Настройки', '/automation':'Автоматизация', '/notifications':'Уведомления', '/activity':'Активность сотрудников', '/crm':'CRM' };
export function sectionForPath(path) {
  const root='/' + String(path || '').split('?')[0].split('/').filter(Boolean)[0];
  return SECTION_LABELS[root] || 'Обзор';
}
export async function presence(user, patch = {}) {
  const { error } = await getServiceDB().from('crm_user_presence').upsert({ user_id:user.id, last_seen_at:new Date().toISOString(), last_logout_at:null, ...patch }, { onConflict:'user_id' });
  if (error) throw error;
}
export async function recordEvent(user, event) {
  const {error}=await getServiceDB().from('crm_activity_events').insert({ user_id:user.id, actor_name:String(user.name || 'Сотрудник').slice(0,200), actor_role:String(user.role || '').slice(0,80), ...event });
  if(error) throw error;
}
export function safeActivity(job) { return Promise.resolve().then(job).catch(error=>console.warn('CRM activity write failed', { code:error.code || 'UNAVAILABLE' })); }
