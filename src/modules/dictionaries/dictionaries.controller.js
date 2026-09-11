import { DictionariesRepository } from './dictionaries.repository.js';

export const getDictionaryItems = async (req, res) => {
  try {
    const { type } = req.query;
    let data = await DictionariesRepository.getItems(type);

    // Изоляция касс для менеджеров: чужие кассы не возвращаются в справочнике
    if (type === 'CASH_DESK' && req.cashDeskAccess && !req.cashDeskAccess.isAdmin) {
      data = (data || []).filter(d => d.id === req.cashDeskAccess.cashDeskId || d.code === req.cashDeskAccess.cashDeskId);
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching dictionaries:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Ошибка загрузки справочников' } });
  }
};

export const createDictionaryItem = async (req, res) => {
  try {
    const data = await DictionariesRepository.createItem(req.body);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error creating dictionary item:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Ошибка создания элемента' } });
  }
};

export const updateDictionaryItem = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await DictionariesRepository.updateItem(id, req.body);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error updating dictionary item:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Ошибка обновления элемента' } });
  }
};

export const deleteDictionaryItem = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await DictionariesRepository.deleteItem(id);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error deleting dictionary item:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Ошибка удаления элемента' } });
  }
};
