import { Router } from "express";
import { z } from "zod";
import { restrictTo } from "../../middleware/auth.middleware.js";
import { getServiceDB } from "../../db/connection.js";
import { AppError } from "../../shared/errors/errorHandler.js";
const router = Router();
const route = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch((err) =>
    next(
      err instanceof z.ZodError
        ? new AppError("Некорректные настройки сообщения", 400)
        : err,
    ),
  );
const checked = (result) => {
  if (result.error)
    throw new AppError("Не удалось сохранить настройки SMS", 500);
  return result.data;
};
export const VARIABLES = {
  client: ["client_name"],
  deal: [
    "client_name",
    "contract_number",
    "apartment",
    "apartment_area",
    "contract_total",
    "currency",
    "total_paid",
    "remaining_balance",
    "project_name",
  ],
  payment: [
    "client_name",
    "contract_number",
    "payment_amount",
    "payment_currency",
    "exchange_rate",
    "payment_equivalent",
    "payment_date",
    "total_paid",
    "contract_currency",
    "remaining_balance",
  ],
  reminder: [
    "client_name",
    "contract_number",
    "payment_amount",
    "currency",
    "payment_date",
  ],
  debt: ["client_name", "contract_number", "overdue_amount", "currency"],
  meeting: ["client_name", "meeting_date", "meeting_time"],
};
export function variablesFor(code) {
  if (code === "CLIENT_WELCOME" || code === "BIRTHDAY") return VARIABLES.client;
  if (code === "MEETING_REMINDER") return VARIABLES.meeting;
  if (code === "PAYMENT_RECEIVED") return VARIABLES.payment;
  if (code === "PAYMENT_REMINDER") return VARIABLES.reminder;
  if (code === "DEBTOR_REMINDER") return VARIABLES.debt;
  return VARIABLES.deal;
}
export function validateTemplate(code, text) {
  const vars = variablesFor(code);
  const tokens = [...text.matchAll(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g)];
  if (
    tokens.some((t) => !vars.includes(t[1])) ||
    /[{}]/.test(text.replace(/\{\{\s*[a-zA-Z_]+\s*\}\}/g, ""))
  )
    throw new AppError(
      "В тексте есть недоступная переменная или незакрытые скобки",
      400,
    );
}
router.use(restrictTo("ADMIN"));
router.get(
  "/",
  route(async (req, res) => {
    const db = getServiceDB();
    const rules = checked(
      await db.from("sms_notification_rules").select("*").order("event_type"),
    );
    const templates = checked(
      await db
        .from("sms_templates")
        .select("*")
        .neq("code", "CUSTOM_MESSAGE")
        .order("id"),
    );
    res.json({
      success: true,
      data: {
        rules,
        templates: templates.map((t) => ({
          ...t,
          variables: variablesFor(t.code),
        })),
        system: {
          provider: "PAYOM",
          confirmationEnabled:
            process.env.SMS_OUTBOX_CONFIRM_ENABLED === "true",
          sender: process.env.PAYOM_SENDER_NAME || "TOZON-PLAZA",
          tokenConfigured: !!process.env.PAYOM_API_TOKEN,
          automaticEnabled:
            process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED === "true",
          detectorEnabled:
            process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED === "true",
          batchLimit: Math.min(
            100,
            Math.max(1, Number(process.env.SMS_AUTO_DISPATCH_BATCH_LIMIT) || 5),
          ),
          timezone: "Asia/Dushanbe",
          dailyTime: "09:00",
        },
      },
    });
  }),
);
const ruleSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["CONFIRM", "INHERIT"]),
    offset_days: z.number().int().min(0).max(30),
    repeat_days: z.number().int().min(1).max(90),
    version: z.number().int().positive(),
  })
  .strict();
router.put(
  "/rules/:type",
  route(async (req, res) => {
    const input = ruleSchema.parse(req.body);
    if (input.mode === "INHERIT" && req.params.type !== "PAYMENT_REMINDER")
      throw new AppError(
        "Этот вид сообщений отправляется только после подтверждения",
        400,
      );
    const { version, ...settings } = input;
    const result = await getServiceDB()
      .from("sms_notification_rules")
      .update({
        ...settings,
        version: version + 1,
        updated_by: req.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("event_type", req.params.type)
      .eq("version", version)
      .select()
      .maybeSingle();
    const rule = checked(result);
    if (!rule)
      throw new AppError("Настройки уже изменены. Обновите страницу.", 409);
    res.json({ success: true, data: rule });
  }),
);
const templateSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    text: z.string().trim().min(1).max(2000),
    is_active: z.boolean(),
    updated_at: z.string(),
  })
  .strict();
router.put(
  "/templates/:id",
  route(async (req, res) => {
    if (!/^[1-9]\d*$/.test(req.params.id))
      throw new AppError("Некорректный шаблон", 400);
    const input = templateSchema.parse(req.body);
    const db = getServiceDB();
    const existing = checked(
      await db
        .from("sms_templates")
        .select("code")
        .eq("id", req.params.id)
        .single(),
    );
    validateTemplate(existing.code, input.text);
    const { updated_at, ...values } = input;
    const template = checked(
      await db
        .from("sms_templates")
        .update({
          ...values,
          updated_at: new Date().toISOString(),
          customized_at: new Date().toISOString(),
        })
        .eq("id", req.params.id)
        .eq("updated_at", updated_at)
        .select()
        .maybeSingle(),
    );
    if (!template)
      throw new AppError("Шаблон уже изменён. Обновите страницу.", 409);
    res.json({
      success: true,
      data: { ...template, variables: variablesFor(template.code) },
    });
  }),
);
router.get(
  "/history",
  route(async (req, res) =>
    res.json({
      success: true,
      data: checked(
        await getServiceDB()
          .from("sms_settings_history")
          .select("id,entity,entity_id,changed_at")
          .order("id", { ascending: false })
          .limit(50),
      ),
    }),
  ),
);
export default router;
