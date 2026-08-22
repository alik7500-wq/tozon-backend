import { getDB } from '../../db/connection.js';

export class DictionariesRepository {
  /**
   * Получить список элементов справочника по типу
   * @param {string} [type] EXPENSE_CATEGORY, INCOME_CATEGORY, LEAD_SOURCE, LOSS_REASON, PAYMENT_METHOD
   */
  static async getItems(type = null) {
    const db = getDB();
    let query = db.from('dictionaries').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true });
    
    if (type) {
      query = query.eq('type', type);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  /**
   * Добавить элемент справочника
   */
  static async createItem(data) {
    const db = getDB();
    const { type, name, code, color, icon, sort_order } = data;
    
    if (!type || !name) {
      throw new Error('Укажите тип справочника и наименование');
    }

    const { data: item, error } = await db.from('dictionaries').insert({
      type,
      name: name.trim(),
      code: code ? code.trim() : null,
      color: color || '#64748b',
      icon: icon || null,
      sort_order: Number(sort_order) || 0,
      is_active: true,
      updated_at: new Date().toISOString()
    }).select().single();

    if (error) throw error;
    return item;
  }

  /**
   * Обновить элемент справочника
   */
  static async updateItem(id, data) {
    const db = getDB();
    const updatePayload = {
      updated_at: new Date().toISOString()
    };

    if (data.name !== undefined) updatePayload.name = data.name.trim();
    if (data.code !== undefined) updatePayload.code = data.code ? data.code.trim() : null;
    if (data.color !== undefined) updatePayload.color = data.color;
    if (data.icon !== undefined) updatePayload.icon = data.icon;
    if (data.sort_order !== undefined) updatePayload.sort_order = Number(data.sort_order);
    if (data.is_active !== undefined) updatePayload.is_active = Boolean(data.is_active);

    const { data: item, error } = await db.from('dictionaries')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return item;
  }

  /**
   * Удалить элемент справочника
   */
  static async deleteItem(id) {
    const db = getDB();
    const { error } = await db.from('dictionaries').delete().eq('id', id);
    if (error) throw error;
    return { success: true, id };
  }
}
