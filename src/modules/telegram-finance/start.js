import { TelegramFinanceRepository } from './repository.js';
import { TelegramAPI, FinanceBot } from './bot.js';

let instance;
export function getFinanceBot() {
  const token = process.env.TELEGRAM_FINANCE_BOT_TOKEN?.trim();
  if (!token) throw new Error('FINANCE_BOT_TOKEN_REQUIRED');
  if (!instance) instance = new FinanceBot(new TelegramFinanceRepository(), new TelegramAPI(token));
  return instance;
}

export function startFinanceBot() {
  const token = process.env.TELEGRAM_FINANCE_BOT_TOKEN?.trim();
  if (!token) return;
  let starting = false;
  let started = false;
  let bot;
  const attempt = async () => {
    if (starting || started) return;
    starting = true;
    try {
      bot = getFinanceBot();
      await bot.start();
      started = true;
      console.log('Telegram finance bot started (22:00 Asia/Dushanbe)');
    } catch { console.warn('Telegram finance bot not ready; retrying without affecting CRM'); }
    finally { starting = false; }
  };
  void attempt();
  const retry = setInterval(() => { void attempt(); }, 30000);
  retry.unref();
  const stop = () => { clearInterval(retry); void bot?.stop().catch(() => {}); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
