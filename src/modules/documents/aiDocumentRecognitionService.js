import OpenAI from 'openai';
import { parseAndValidateMRZ } from './mrzValidator.js';

const SYSTEM_PROMPT = `You are extracting identity-document data using Multimodal Vision.

Extract only information visibly present in the provided document images.
Never infer or invent missing characters, numbers, names, dates, addresses, authorities, or document identifiers.
If a value cannot be read reliably, return null.
Preserve the spelling printed on the document.
Treat every extracted value as unverified until confirmed by the user.

Analyze all provided images (which may be front/back of an ID card, passport main page, or registration page) together as ONE single document.

Assess document photo quality first:
- acceptable: boolean (true if legible for extraction)
- blur_detected: boolean
- glare_detected: boolean
- document_cut_off: boolean
- too_dark: boolean
- fields_obscured: boolean
- reason: string or null (explanation if acceptable is false)

Extract document structure:
- country: 3-letter ISO code or common short code (e.g. "TJK", "RUS", "UZB", "KAZ", "KGZ")
- country_name: Country name in Russian (e.g. "Таджикистан", "Россия", "Узбекистан")
- document_type: "passport" | "international_passport" | "id_card" | "residence_permit" | "unknown"
- document_number: string or null (e.g. "A03195738", "4510 123456")
- personal_number: string or null (PIN / INN / National ID number)
- surname: string or null (Cyrillic / primary script as printed)
- given_name: string or null (Cyrillic / primary script as printed)
- patronymic: string or null (Cyrillic / primary script if printed)
- surname_latin: string or null (Latin transliteration if visibly printed on document)
- given_name_latin: string or null (Latin transliteration if visibly printed on document)
- birth_date: string (YYYY-MM-DD format if readable, else null)
- birth_place: string or null
- sex: "M" | "F" | null
- nationality: string or null
- issue_date: string (YYYY-MM-DD format if readable, else null)
- expiry_date: string (YYYY-MM-DD format if readable, else null)
- issuing_authority: string or null (e.g. "ШВКД-1 дар ш. Хуҷанд", "ОМВД России")
- registered_address: string or null (Full registration address if visible)
- inn: string or null (Taxpayer ID / ИНН / РМА if visible)
- mrz_present: boolean
- mrz_line_1: string or null
- mrz_line_2: string or null
- mrz_line_3: string or null

Provide confidence scores (0.0 to 1.0) for extracted fields in confidence object:
- document_number, surname, given_name, birth_date, expiry_date, issuing_authority, registered_address, inn.`;

const JSON_SCHEMA = {
  type: "object",
  properties: {
    quality: {
      type: "object",
      properties: {
        acceptable: { type: "boolean" },
        blur_detected: { type: "boolean" },
        glare_detected: { type: "boolean" },
        document_cut_off: { type: "boolean" },
        too_dark: { type: "boolean" },
        fields_obscured: { type: "boolean" },
        reason: { type: ["string", "null"] }
      },
      required: ["acceptable", "blur_detected", "glare_detected", "document_cut_off", "too_dark", "fields_obscured", "reason"],
      additionalProperties: false
    },
    document: {
      type: "object",
      properties: {
        country: { type: ["string", "null"] },
        country_name: { type: ["string", "null"] },
        document_type: { type: ["string", "null"] },
        document_number: { type: ["string", "null"] },
        personal_number: { type: ["string", "null"] },
        surname: { type: ["string", "null"] },
        given_name: { type: ["string", "null"] },
        patronymic: { type: ["string", "null"] },
        surname_latin: { type: ["string", "null"] },
        given_name_latin: { type: ["string", "null"] },
        birth_date: { type: ["string", "null"] },
        birth_place: { type: ["string", "null"] },
        sex: { type: ["string", "null"] },
        nationality: { type: ["string", "null"] },
        issue_date: { type: ["string", "null"] },
        expiry_date: { type: ["string", "null"] },
        issuing_authority: { type: ["string", "null"] },
        registered_address: { type: ["string", "null"] },
        inn: { type: ["string", "null"] },
        mrz_present: { type: "boolean" },
        mrz_line_1: { type: ["string", "null"] },
        mrz_line_2: { type: ["string", "null"] },
        mrz_line_3: { type: ["string", "null"] }
      },
      required: [
        "country", "country_name", "document_type", "document_number", "personal_number",
        "surname", "given_name", "patronymic", "surname_latin", "given_name_latin",
        "birth_date", "birth_place", "sex", "nationality", "issue_date", "expiry_date",
        "issuing_authority", "registered_address", "inn", "mrz_present",
        "mrz_line_1", "mrz_line_2", "mrz_line_3"
      ],
      additionalProperties: false
    },
    confidence: {
      type: "object",
      properties: {
        document_number: { type: ["number", "null"] },
        surname: { type: ["number", "null"] },
        given_name: { type: ["number", "null"] },
        birth_date: { type: ["number", "null"] },
        expiry_date: { type: ["number", "null"] },
        issuing_authority: { type: ["number", "null"] },
        registered_address: { type: ["number", "null"] },
        inn: { type: ["number", "null"] }
      },
      required: [
        "document_number", "surname", "given_name", "birth_date",
        "expiry_date", "issuing_authority", "registered_address", "inn"
      ],
      additionalProperties: false
    }
  },
  required: ["quality", "document", "confidence"],
  additionalProperties: false
};

function normalizeDateStr(raw) {
  if (!raw) return null;
  const match = String(raw).trim().match(/^(\d{4})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return null;
}

function validateDates(doc) {
  const warnings = [];
  const today = new Date().toISOString().split('T')[0];

  if (doc.birth_date) {
    const norm = normalizeDateStr(doc.birth_date);
    if (!norm || norm > today) {
      warnings.push(`Дата рождения (${doc.birth_date}) некорректна или указывает на будущее`);
      doc.birth_date = null;
    } else {
      doc.birth_date = norm;
    }
  }

  if (doc.issue_date) {
    const norm = normalizeDateStr(doc.issue_date);
    if (!norm || norm > today) {
      warnings.push(`Дата выдачи (${doc.issue_date}) некорректна или указывает на будущее`);
      doc.issue_date = null;
    } else {
      doc.issue_date = norm;
    }
  }

  if (doc.expiry_date) {
    const norm = normalizeDateStr(doc.expiry_date);
    if (!norm) {
      warnings.push(`Дата окончания срока действия (${doc.expiry_date}) некорректна`);
      doc.expiry_date = null;
    } else {
      doc.expiry_date = norm;
      if (doc.issue_date && norm <= doc.issue_date) {
        warnings.push(`Срок действия (${norm}) равен или раньше даты выдачи (${doc.issue_date})`);
      }
      if (doc.birth_date && norm <= doc.birth_date) {
        warnings.push(`Срок действия (${norm}) равен или раньше даты рождения (${doc.birth_date})`);
      }
    }
  }

  return warnings;
}

function detectMRZConflicts(doc, mrzParsed) {
  const conflicts = [];
  if (!mrzParsed || !mrzParsed.valid) return conflicts;

  const fieldsToCompare = [
    { field: 'document_number', visual: doc.document_number, mrz: mrzParsed.document_number },
    { field: 'birth_date', visual: doc.birth_date, mrz: mrzParsed.birth_date },
    { field: 'expiry_date', visual: doc.expiry_date, mrz: mrzParsed.expiry_date },
    { field: 'sex', visual: doc.sex, mrz: mrzParsed.sex },
    { field: 'nationality', visual: doc.nationality, mrz: mrzParsed.nationality }
  ];

  for (const item of fieldsToCompare) {
    if (item.visual && item.mrz) {
      const cleanVisual = String(item.visual).replace(/[\s\-_]/g, '').toUpperCase();
      const cleanMrz = String(item.mrz).replace(/[\s\-_]/g, '').toUpperCase();
      if (cleanVisual !== cleanMrz) {
        conflicts.push({
          field: item.field,
          visual_value: item.visual,
          mrz_value: item.mrz
        });
      }
    }
  }

  return conflicts;
}

export class AIDocumentRecognitionService {
  static async analyzePassportImages(imageBuffers) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY_MISSING: API key for OpenAI is not configured on server.");
    }

    const modelName = process.env.OPENAI_PASSPORT_MODEL || 'gpt-4o';
    const openai = new OpenAI({ apiKey });

    // Prepare vision payload
    const imageContentParts = imageBuffers.map((img, idx) => ({
      type: 'image_url',
      image_url: {
        url: `data:${img.mimeType || 'image/jpeg'};base64,${img.buffer.toString('base64')}`,
        detail: 'high'
      }
    }));

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze the attached identity document image(s) and return structured JSON output.' },
          ...imageContentParts
        ]
      }
    ];

    const startTime = Date.now();

    const response = await openai.chat.completions.create({
      model: modelName,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "passport_document_analysis",
          strict: true,
          schema: JSON_SCHEMA
        }
      },
      temperature: 0.1,
      max_tokens: 2000
    });

    const durationMs = Date.now() - startTime;
    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error("OPENAI_EMPTY_RESPONSE: No response content returned from Vision API");
    }

    const parsed = JSON.parse(content);
    const doc = parsed.document || {};
    const quality = parsed.quality || {};
    const confidence = parsed.confidence || {};

    // Validate Legibility Quality
    if (!quality.acceptable) {
      return {
        success: false,
        duration_ms: durationMs,
        model: modelName,
        quality,
        document: null,
        confidence: null,
        conflicts: [],
        warnings: [quality.reason || 'Изображение непригодно для считывания данных']
      };
    }

    // Normalize & validate dates
    const dateWarnings = validateDates(doc);

    // Parse & Check MRZ if present
    let mrzParsed = null;
    if (doc.mrz_present && (doc.mrz_line_1 || doc.mrz_line_2)) {
      mrzParsed = parseAndValidateMRZ({
        line1: doc.mrz_line_1,
        line2: doc.mrz_line_2,
        line3: doc.mrz_line_3
      });
    }

    // Compare Visual Zone vs MRZ
    const conflicts = detectMRZConflicts(doc, mrzParsed);

    const reviewThreshold = parseFloat(process.env.AI_PASSPORT_REVIEW_THRESHOLD || '0.85');

    // Attach review warnings for low confidence fields
    const warnings = [...dateWarnings];
    for (const [field, score] of Object.entries(confidence)) {
      if (score !== null && score < reviewThreshold && doc[field]) {
        warnings.push(`Поле ${field} требует проверки (уверенность: ${Math.round(score * 100)}%)`);
      }
    }

    return {
      success: true,
      duration_ms: durationMs,
      model: modelName,
      quality,
      document: doc,
      confidence,
      mrz_validation: mrzParsed,
      conflicts,
      warnings,
      threshold_used: reviewThreshold
    };
  }
}
