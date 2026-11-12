// Tajik SMS copy. Keep variable names identical to the Russian canonical templates.
// Never translate numeric amounts, contract identifiers, dates, or currency codes.
export const TAJIK_SMS_TEMPLATES = Object.freeze({
  CLIENT_WELCOME: 'Салом, {{client_name}}! Ташаккур барои муроҷиат ба шуъбаи фурӯши TOZON-PLAZA.',
  MEETING_REMINDER: 'Салом, {{client_name}}! Вохӯрии шуморо рӯзи {{meeting_date}} соати {{meeting_time}} хотиррасон мекунем. TOZON-PLAZA.',
  DEAL_INFO: '{{client_name}}, шартномаи №{{contract_number}}, хонаи №{{apartment}} ({{apartment_area}} м²). Арзиш: {{contract_total}} {{currency}}; пардохтшуда: {{total_paid}} {{currency}}; бақия: {{remaining_balance}} {{currency}}. TOZON-PLAZA.',
  PAYMENT_REMINDER: 'Салом, {{client_name}}! Хотиррасон мекунем, ки тибқи шартномаи №{{contract_number}} то {{payment_date}} маблағи {{payment_amount}} {{currency}} пардохт карда шавад. TOZON-PLAZA.',
  DEBTOR_REMINDER: 'Муҳтарам {{client_name}}! Лутфан қарзи муҳлатгузаштаи {{overdue_amount}} {{currency}}-ро тибқи шартномаи №{{contract_number}} пардохт намоед. TOZON-PLAZA.',
  PAYMENT_RECEIVED: 'Муҳтарам {{client_name}}! Пардохти {{payment_amount}} {{payment_currency}} тибқи шартномаи №{{contract_number}} қабул шуд. Ҳамагӣ пардохтшуда: {{total_paid}} {{contract_currency}}. Бақия: {{remaining_balance}} {{contract_currency}}. Ташаккур! TOZON-PLAZA.',
  BIRTHDAY: 'Муҳтарам {{client_name}}! Шуморо бо рӯзи таваллуд табрик мегӯем! Бароятон саломатӣ ва хушбахтӣ орзумандем. TOZON-PLAZA.',
  CONTRACT_CREATED: 'Муҳтарам {{client_name}}! Шуморо бо бастани шартнома барои хонаи №{{apartment}} табрик мегӯем. TOZON-PLAZA.',
  CONTRACT_CHANGED: 'Салом, {{client_name}}! Ба шартномаи №{{contract_number}} тағйирот ворид карда шуд. Барои маълумоти бештар бо мо тамос гиред. TOZON-PLAZA.',
  CONTRACT_PAID: 'Салом, {{client_name}}! Шартномаи №{{contract_number}} пурра пардохт шудааст. Ташаккур! TOZON-PLAZA.',
  CONTRACT_TERMINATED: 'Салом, {{client_name}}! Шартномаи №{{contract_number}} қатъ карда шуд. TOZON-PLAZA.',
  PAYMENT_CANCELLED: 'Салом, {{client_name}}! Пардохт тибқи шартномаи №{{contract_number}} бекор карда шуд. Лутфан бо мо тамос гиред. TOZON-PLAZA.',
  RESERVATION_CANCELLED: 'Салом, {{client_name}}! Банди хонаи №{{apartment}} бекор карда шуд. TOZON-PLAZA.',
  RESERVATION_CREATED: 'Салом, {{client_name}}! Хонаи №{{apartment}} барои шумо банд карда шуд. TOZON-PLAZA.',
  RESERVATION_EXPIRING: 'Салом, {{client_name}}! Муҳлати банди хонаи №{{apartment}} ба анҷом мерасад. Лутфан бо мо тамос гиред. TOZON-PLAZA.',
  SCHEDULE_CHANGED: 'Салом, {{client_name}}! Ҷадвали пардохти шартномаи №{{contract_number}} тағйир ёфт. Лутфан ҷадвали навро аз мо дастрас намоед. TOZON-PLAZA.'
});

export function normalizeSmsLanguage(value) {
  if (value === undefined || value === null || value === '') return 'tj';
  if (value === 'tj' || value === 'ru') return value;
  throw new Error('Unsupported SMS language');
}

export function resolveSmsTemplateLanguage({ code, language, russianText }) {
  const normalized = normalizeSmsLanguage(language);
  if (normalized === 'ru') return russianText;
  const translated = TAJIK_SMS_TEMPLATES[code];
  if (!translated) throw new Error('Tajik SMS template unavailable: ' + String(code));
  return translated;
}
