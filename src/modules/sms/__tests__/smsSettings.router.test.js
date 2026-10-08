import { SmsService } from "../sms.service.js";
import { LeadsRepository } from "../../leads/leads.repository.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import router, { validateTemplate } from "../smsSettings.router.js";
import { errorHandler } from "../../../shared/errors/errorHandler.js";
import * as connection from "../../../db/connection.js";
import { SmsSettingsRepository } from "../smsSettings.repository.js";
import { SmsEventsService } from "../smsEvents.service.js";
import { SmsRepository } from "../sms.repository.js";
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = { id: 1, role: req.headers["x-role"] || "ADMIN" };
  next();
});
app.use("/settings", router);
app.use(errorHandler);
let db, chain;
beforeEach(() => {
  vi.restoreAllMocks();
  chain = {
    select: vi.fn(() => chain),
    order: vi.fn(async () => ({ data: [], error: null })),
    neq: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    update: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: { code: "BIRTHDAY" }, error: null })),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  };
  db = { from: vi.fn(() => chain) };
  vi.spyOn(connection, "getServiceDB").mockReturnValue(db);
});
it("only administrators can read or edit notification configuration", async () => {
  expect(
    (await request(app).get("/settings").set("x-role", "MANAGER")).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .put("/settings/rules/BIRTHDAY")
        .set("x-role", "DIRECTOR")
        .send({})
    ).status,
  ).toBe(403);
  expect(db.from).not.toHaveBeenCalled();
});
it("returns connection status without credentials", async () => {
  process.env.PAYOM_API_TOKEN = "private-test-token";
  try {
    const res = await request(app).get("/settings");
    expect(res.status).toBe(200);
    expect(res.body.data.system.tokenConfigured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("private-test-token");
  } finally {
    delete process.env.PAYOM_API_TOKEN;
  }
});
it("uses compare-and-swap for concurrent rule changes", async () => {
  const res = await request(app).put("/settings/rules/BIRTHDAY").send({
    enabled: true,
    mode: "CONFIRM",
    offset_days: 1,
    repeat_days: 7,
    version: 4,
  });
  expect(res.status).toBe(409);
  expect(chain.eq).toHaveBeenCalledWith("version", 4);
  expect(chain.update).toHaveBeenCalledWith(
    expect.objectContaining({ version: 5, updated_by: 1 }),
  );
});
it("rejects automatic sending for new types and invalid settings", async () => {
  expect(
    (
      await request(app).put("/settings/rules/BIRTHDAY").send({
        enabled: true,
        mode: "INHERIT",
        offset_days: 1,
        repeat_days: 7,
        version: 1,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app).put("/settings/rules/PAYMENT_REMINDER").send({
        enabled: true,
        mode: "CONFIRM",
        offset_days: 999,
        repeat_days: 7,
        version: 1,
      })
    ).status,
  ).toBe(400);
  expect(chain.update).not.toHaveBeenCalled();
});
it("rejects unavailable placeholders before updating template", async () => {
  expect(() =>
    validateTemplate("BIRTHDAY", "Поздравляем {{contract_total}}"),
  ).toThrow();
  expect(() =>
    validateTemplate("PAYMENT_CANCELLED", "{{payment_amount}}"),
  ).toThrow();
  expect(() => validateTemplate("BIRTHDAY", "{{client_name}")).toThrow();
  expect(() =>
    validateTemplate(
      "PAYMENT_RECEIVED",
      "{{payment_amount}} {{payment_currency}}",
    ),
  ).not.toThrow();
  const res = await request(app).put("/settings/templates/1").send({
    name: "День рождения",
    text: "{{unknown}}",
    is_active: true,
    updated_at: "2026-10-08T00:00:00Z",
  });
  expect(res.status).toBe(400);
  expect(chain.update).not.toHaveBeenCalled();
});
it("disabled rules block confirmation without provider calls", async () => {
  vi.spyOn(SmsSettingsRepository, "getRule").mockResolvedValue({
    enabled: false,
  });
  const provider = { sendSms: vi.fn() };
  const service = new SmsEventsService({ provider });
  await expect(
    service.validateEventContext({
      event_type: "BIRTHDAY",
      payload_json: { managed_rule: true },
    }),
  ).rejects.toMatchObject({ code: "SMS_RULE_DISABLED" });
  expect(provider.sendSms).not.toHaveBeenCalled();
});
it("empty or broken database templates do not restore disabled hardcoded texts", async () => {
  chain.order.mockResolvedValueOnce({ data: [], error: null });
  expect(await SmsRepository.getTemplates()).toEqual([]);
  chain.order.mockResolvedValueOnce({
    data: null,
    error: { message: "offline" },
  });
  await expect(SmsRepository.getTemplates()).rejects.toMatchObject({
    statusCode: 503,
  });
});

it("honors edited payment text for multi-currency payments without invoking provider", async () => {
  const provider = { sendSms: vi.fn() };
  const service = new SmsService(provider);
  vi.spyOn(SmsRepository, "getTemplates").mockResolvedValue([
    {
      code: "PAYMENT_RECEIVED",
      is_active: true,
      text: "Спасибо, {{client_name}}! Принято {{payment_amount}} {{payment_currency}}.",
      customized_at: "2026-10-08",
    },
  ]);
  vi.spyOn(LeadsRepository, "findById").mockResolvedValue({
    id: 1,
    full_name: "Тестовый клиент",
  });
  vi.spyOn(service, "calculatePaymentContext").mockResolvedValue({
    payment: { id: 1 },
    deal: { id: 1, lead_id: 1 },
    isMultiCurrency: true,
    paymentAmountFormatted: "10 000",
    paymentCurrency: "TJS",
  });
  const preview = await service.previewSms({
    templateCode: "PAYMENT_RECEIVED",
    clientId: 1,
    dealId: 1,
    paymentId: 1,
  });
  expect(preview.text).toBe("Спасибо, Тестовый клиент! Принято 10 000 TJS.");
  expect(provider.sendSms).not.toHaveBeenCalled();
});
