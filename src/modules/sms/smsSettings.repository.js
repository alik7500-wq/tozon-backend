import { getServiceDB } from "../../db/connection.js";
import { AppError } from "../../shared/errors/errorHandler.js";
export class SmsSettingsRepository {
  static async getRule(type) {
    const { data, error } = await getServiceDB()
      .from("sms_notification_rules")
      .select("*")
      .eq("event_type", type)
      .single();
    if (error || !data)
      throw new AppError("Не удалось прочитать настройки SMS", 503);
    return data;
  }
  static async daily() {
    const { data, error } = await getServiceDB().rpc(
      "queue_daily_configured_sms",
    );
    if (error) throw new AppError("Не удалось подготовить ежедневные SMS", 503);
    return data;
  }
}
