import { connectDB } from '../db/connection.js';

function parseAmarDate(dateStr) {
  if (!dateStr) return new Date().toISOString();
  const match = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    const [, day, month, year, hour, min, sec] = match;
    const d = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}+05:00`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function cleanPhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return `+${digits}`;
}

const amarClients = [
  // Page 1
  { amarId: 2, name: 'Бобочонова Насибачон Махкамовна', phone: '+992 92 709 5557', dealsCount: 1, createdAt: '09.02.2026, 19:14:10' },
  { amarId: 3, name: 'Азимова Муаззама Собирчоновна', phone: '+7 999 782 98 35', dealsCount: 3, createdAt: '09.02.2026, 19:20:27' },
  { amarId: 4, name: 'Сатторова Зиёда Абдукодировна', phone: '+992 93 308 5001', dealsCount: 2, createdAt: '09.02.2026, 19:22:47' },
  { amarId: 5, name: 'Хомидов Рахмон Ахмедович', phone: '+992 92 588 8841', dealsCount: 2, createdAt: '10.02.2026, 19:32:59' },
  { amarId: 7, name: 'Раупов Юсуфчон Абдухалилович', phone: '+992 92 840 8957', dealsCount: 1, createdAt: '12.02.2026, 11:09:18' },
  { amarId: 8, name: 'Shodiev Ahliyor', phone: '+992 91 987 7799', dealsCount: 0, createdAt: '12.02.2026, 11:14:40' },
  { amarId: 9, name: 'Мухаммадназарова Малика Саидбаевна', phone: '+992 11 504 6000', dealsCount: 4, createdAt: '12.02.2026, 13:44:58' },
  { amarId: 10, name: 'Абдуллоева Зебичон Махкамовна', phone: '+992 92 825 0030', dealsCount: 1, createdAt: '12.02.2026, 14:15:02' },
  { amarId: 12, name: 'Урунов Алиакбар Махмудчонович', phone: '+992 92 820 0990', dealsCount: 1, createdAt: '13.02.2026, 12:48:32' },
  { amarId: 13, name: 'Маджидов Бехзод', phone: '+992 88 297 9999', dealsCount: 0, createdAt: '14.02.2026, 05:55:03' },
  { amarId: 14, name: 'Имомзода Афзалшох Заврони', phone: '+992 90 566 6007', dealsCount: 1, createdAt: '14.02.2026, 06:55:38' },
  { amarId: 15, name: 'Олимчонов Наимчон Негматчонович', phone: '+992 92 766 7232', dealsCount: 1, createdAt: '18.02.2026, 09:13:03' },
  // Page 2
  { amarId: 16, name: 'Шерматов Осимчон Олимович', phone: '+992 92 733 4344', dealsCount: 1, createdAt: '07.03.2026, 07:27:17' },
  { amarId: 17, name: 'Бобочонов Тохир Мамадчонович', phone: '+992 92 741 0144', dealsCount: 1, createdAt: '10.03.2026, 11:19:53' },
  { amarId: 21, name: 'Ахророва Мадина Муминовна', phone: '+992 11 008 1884', dealsCount: 2, createdAt: '13.03.2026, 10:04:40' },
  { amarId: 22, name: 'Урунова Саноат Абдуллоевна', phone: '+992 92 880 5084', dealsCount: 1, createdAt: '17.03.2026, 13:12:36' },
  { amarId: 23, name: 'Бобохонов Диловархон Чамшедхонович', phone: '+992 92 902 0335', dealsCount: 1, createdAt: '23.03.2026, 09:33:47' },
  { amarId: 24, name: 'Бобохонов Чамшедхон Осимович', phone: '+992 92 774 1212', dealsCount: 1, createdAt: '23.03.2026, 09:35:03' },
  { amarId: 25, name: 'Тухтаев Абдухаким Ахмадович', phone: '+992 98 522 1503', dealsCount: 0, createdAt: '08.04.2026, 16:26:10' },
  { amarId: 26, name: 'Каюмов Фарход Абдувохидович', phone: '+992 92 633 1111', dealsCount: 2, createdAt: '15.04.2026, 06:52:01' },
  { amarId: 27, name: 'Солиев Мухсин Миробидович', phone: '+992 99 800 8288', dealsCount: 3, createdAt: '17.04.2026, 12:00:53' },
  { amarId: 28, name: 'Разоков Абдухалил Абдураззокович', phone: '+992 03 222 2000', dealsCount: 1, createdAt: '02.05.2026, 10:14:49' },
  { amarId: 29, name: 'Ишонов Лутфуллохон Хайруллохонович', phone: '', dealsCount: 1, createdAt: '05.05.2026, 12:52:55' },
  { amarId: 30, name: 'Бойматов Чамшед Косимович', phone: '+992 92 928 4040', dealsCount: 1, createdAt: '13.05.2026, 04:30:55' },
  // Page 3
  { amarId: 31, name: 'Хочизода Мирзошокир Мирзошариф', phone: '+992 92 797 0069', dealsCount: 1, createdAt: '13.05.2026, 11:06:40' },
  { amarId: 32, name: 'Зоидова Назокат Негматовна', phone: '+992 92 855 5570', dealsCount: 2, createdAt: '16.05.2026, 06:17:52' },
  { amarId: 33, name: 'Усмонов Рахматуллочон Рахмонович', phone: '+992 88 777 7797', dealsCount: 1, createdAt: '20.05.2026, 03:04:02' },
  { amarId: 34, name: 'Юлдошев Каримчон Ахмедович', phone: '+992 92 856 6895', dealsCount: 1, createdAt: '20.05.2026, 09:50:05' },
  { amarId: 35, name: 'Исмоилов Аскар Дадочонович', phone: '+992 92 790 0024', dealsCount: 1, createdAt: '09.07.2026, 07:03:34' },
  { amarId: 36, name: 'Ашуров Расулчон Комилович', phone: '+992 92 607 2222', dealsCount: 1, createdAt: '21.07.2026, 09:50:44' },
  { amarId: 37, name: 'Усмонов Наимчон', phone: '+992 92 907 0600', dealsCount: 1, createdAt: '21.08.2026, 09:36:58' }
];

async function runImport() {
  const db = connectDB();

  // 1. Fetch current leads
  const { data: dbLeads, error } = await db.from('leads').select('*');
  if (error) {
    console.error('Error fetching leads:', error);
    process.exit(1);
  }

  const normalizePhone = p => (p || '').replace(/\D/g, '');
  const normalizeName = n => (n || '').toLowerCase().replace(/[^a-zа-яёҷӣӯҳқғ]/gi, ' ').replace(/\s+/g, ' ').trim();

  const toInsert = [];
  const matched = [];

  for (const c of amarClients) {
    const cPhone = normalizePhone(c.phone);
    const cName = normalizeName(c.name);

    const match = dbLeads.find(l => {
      const lPhone = normalizePhone(l.phone);
      const lSecPhone = normalizePhone(l.secondary_phone);
      const lName = normalizeName(l.full_name);

      if (cPhone && (lPhone === cPhone || lSecPhone === cPhone)) return true;
      if (cName && (lName === cName || lName.includes(cName) || cName.includes(lName))) return true;
      return false;
    });

    if (match) {
      matched.push({ amar: c, db: match });
    } else {
      const parsedDate = parseAmarDate(c.createdAt);
      toInsert.push({
        full_name: c.name.trim(),
        phone: cleanPhone(c.phone),
        secondary_phone: null,
        source: 'DIRECT',
        status: c.dealsCount > 0 ? 'WON' : 'NEW',
        notes: `Импортирован из Амар.СРМ (ID: ${c.amarId}, Сделок: ${c.dealsCount}${!c.phone ? ', телефон отсутствует' : ''})`,
        created_at: parsedDate,
        updated_at: parsedDate
      });
    }
  }

  console.log(`Всего в списке Амар.СРМ: ${amarClients.length}`);
  console.log(`Уже есть в базе ТОЗОН СРМ: ${matched.length}`);
  console.log(`Отсутствуют и будут добавлены: ${toInsert.length}`);

  if (toInsert.length > 0) {
    console.log('\n--- Добавление недостающих покупателей ---');
    const { data: inserted, error: insertError } = await db
      .from('leads')
      .insert(toInsert)
      .select();

    if (insertError) {
      console.error('Ошибка при вставке в базу данных:', insertError);
      process.exit(1);
    }

    console.log(`Успешно добавлено ${inserted.length} клиентов в ТОЗОН СРМ!`);
    inserted.forEach((item, idx) => {
      console.log(`${idx + 1}. [ID: ${item.id}] ${item.full_name} | ${item.phone || 'без телефона'} | Статус: ${item.status}`);
    });
  }

  // Also check if Amar ID 9 has secondary phone we can update
  const malikaMatch = matched.find(m => m.amar.amarId === 9);
  if (malikaMatch && malikaMatch.db.phone && !malikaMatch.db.secondary_phone) {
    const sec = cleanPhone(malikaMatch.amar.phone);
    if (sec && sec !== malikaMatch.db.phone) {
      await db.from('leads').update({ secondary_phone: sec }).eq('id', malikaMatch.db.id);
      console.log(`\nОбновлен дополнительный телефон для ${malikaMatch.db.full_name}: ${sec}`);
    }
  }

  console.log('\nОперация синхронизации успешно завершена!');
}

runImport().catch(console.error);
