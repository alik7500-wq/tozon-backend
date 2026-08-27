import { parseMRZ } from './mrzParser.js';

/**
 * Normalization Helpers
 */
export function normalizeDate(rawDate) {
  if (!rawDate) return null;
  const str = String(rawDate).trim();

  // If already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // DD.MM.YYYY or DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  // YYYY.MM.DD
  const ymdMatch = str.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = ymdMatch[2].padStart(2, '0');
    const day = ymdMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return null;
}

export function normalizeName(name) {
  if (!name) return null;
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(word => word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : '')
    .join(' ');
}

export function normalizePassportNumber(num) {
  if (!num) return null;
  return num.toUpperCase().replace(/[^A-Z0-9А-Я]/g, '');
}

export function normalizeINN(inn) {
  if (!inn) return null;
  const digits = String(inn).replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 14 ? digits : null;
}

/**
 * Rule-based Pattern Extractor for Tajik, Russian, and CIS Passport Documents
 */
export function extractFieldsFromText(text) {
  if (!text) return {};

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const fullText = lines.join('\n');

  const fields = {};

  // 1. Passport Series & Number
  // Examples: A03195738, A 03195738, 4014 123456, 40 14 123456
  const passportRegexes = [
    /(?:рақами\s*шиноснома|паспорт|серия\s*и\s*номер|паспорт\s*№|№)\s*[:.]?\s*([A-ZА-Я]{1,2})\s*([0-9]{6,8})/i,
    /\b([A-ZА-Я]{1,2})\s*([0-9]{7,8})\b/,
    /\b([0-9]{2}\s*[0-9]{2})\s*([0-9]{6})\b/
  ];

  for (const reg of passportRegexes) {
    const m = fullText.match(reg);
    if (m) {
      if (m[2]) {
        fields.passport_series = m[1].toUpperCase().replace(/\s/g, '');
        fields.passport_number = m[2];
        fields.passport_series_number = `${fields.passport_series}${fields.passport_number}`;
      } else if (m[1]) {
        fields.passport_number = m[1];
        fields.passport_series_number = m[1];
      }
      break;
    }
  }

  // 2. Names (Насаб / Фамилия, Ном / Имя, Номи падар / Отчество)
  const surnameRegexes = [
    /(?:^|\n|\r|[/\\])\s*(?:насаб|насаби\s*шаҳрванд|фамилия|surname)\s*[:.\-]?\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-]+)/i,
    /(?:^|\s)(?:насаб|фамилия)\s*[:.]\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-]+)/i
  ];
  for (const reg of surnameRegexes) {
    const m = fullText.match(reg);
    if (m) { fields.last_name = normalizeName(m[1]); break; }
  }

  const nameRegexes = [
    /(?:^|\n|\r|[/\\])\s*(?:номи\s*шаҳрванд|ном|имя|given\s*names?)\s*[:.\-]?\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-]+)/i,
    /(?:^|\s)(?:ном|имя)\s*[:.]\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-]+)/i
  ];
  for (const reg of nameRegexes) {
    const m = fullText.match(reg);
    if (m) { fields.first_name = normalizeName(m[1]); break; }
  }

  const middleNameRegexes = [
    /(?:^|\n|\r|[/\\])\s*(?:номи\s*падар|отчество|patronymic)\s*[:.\-]?\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-]+)/i,
    /(?:^|\s)(?:номи\s*падар|отчество)\s*[:.]\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-]+)/i
  ];
  for (const reg of middleNameRegexes) {
    const m = fullText.match(reg);
    if (m) { fields.middle_name = normalizeName(m[1]); break; }
  }

  // 3. Dates (Санаи таваллуд, Санаи додани шиноснома)
  const birthDateRegexes = [
    /(?:санаи\s*таваллуд|дата\s*рождения|т[ао]валлуд|date\s*of\s*birth)\s*[:.]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/i,
    /(?:таваллуд\s*шудааст)\s*[:.]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i
  ];
  for (const reg of birthDateRegexes) {
    const m = fullText.match(reg);
    if (m) { fields.birth_date = normalizeDate(m[1]); break; }
  }

  const issueDateRegexes = [
    /(?:санаи\s*додани(?:\s*шиноснома)?|дата\s*выдачи(?:\s*паспорта)?|дода\s*шудааст|date\s*of\s*issue)\s*[:.]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/i,
    /(?:санаи\s*додани|дата\s*выдачи)[^\n\r:.]*[:.]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/i
  ];
  for (const reg of issueDateRegexes) {
    const m = fullText.match(reg);
    if (m) { fields.issue_date = normalizeDate(m[1]); break; }
  }

  // 4. Issuing Authority (Мақоми додани шиноснома / Кем выдан)
  const authorityRegexes = [
    /(?:мақоми\s*додани\s*шиноснома|мақоми\s*додашуда|кем\s*выдан|паспорт\s*дода\s*шудааст)\s*[:.]?\s*([^\n\r]+)/i,
    /(?:ШВКД\s*[^\n\r]+|МВД\s*[^\n\r]+|ОУФМС\s*[^\n\r]+)/i
  ];
  for (const reg of authorityRegexes) {
    const m = fullText.match(reg);
    if (m) {
      const auth = (m[1] || m[0]).trim().replace(/^[;:,.\s]+|[;:,.\s]+$/g, '');
      if (auth.length >= 4) {
        fields.issuing_authority = auth;
        break;
      }
    }
  }

  // 5. INN / РМА (9-12 digits)
  const innRegexes = [
    /(?:рма|инн|tax\s*id|рақами\s*мушаххаси\s*андозсупоранда)\s*[:.]?\s*(\d{9,12})/i,
    /\b(\d{9})\b/
  ];
  for (const reg of innRegexes) {
    const m = fullText.match(reg);
    if (m) { fields.inn = normalizeINN(m[1]); break; }
  }

  // 6. Address / Суроға / Прописка
  const addressRegexes = [
    /(?:суроға|сурога|адрес|ҷои\s*зист|прописка|место\s*жительства)\s*[:.]?\s*([^\n\r]+)/i
  ];
  for (const reg of addressRegexes) {
    const m = fullText.match(reg);
    if (m) {
      const addr = m[1].trim().replace(/^[;:,.\s]+|[;:,.\s]+$/g, '');
      if (addr.length >= 6) {
        fields.address = addr;
        break;
      }
    }
  }

  return fields;
}

/**
 * Provider-agnostic Passport OCR Service
 */
export class PassportOCRService {
  /**
   * Main Recognition Pipeline
   * @param {Buffer|string} frontInput Image buffer, base64 or text of front side
   * @param {Buffer|string} backInput Image buffer, base64 or text of back side
   * @param {Object} options Options & hints
   */
  static async recognizePassport(frontInput, backInput = null, options = {}) {
    const warnings = [];
    const fieldsWithConfidence = {};

    // 1. Convert input to text representations
    let rawText = '';
    if (typeof frontInput === 'string') {
      rawText += frontInput + '\n';
    }
    if (typeof backInput === 'string') {
      rawText += backInput + '\n';
    }

    // 2. Run ICAO 9303 MRZ Engine
    const mrzResult = parseMRZ(rawText);

    // 3. Run visual regex pattern extraction
    const visualFields = extractFieldsFromText(rawText);

    // 4. Merge and cross-validate MRZ + Visual fields
    // A. Passport Number / Series
    let finalDocNumber = null;
    let docNumberConfidence = 0.5;
    let docNumberSource = 'NONE';

    if (mrzResult && mrzResult.document_number) {
      finalDocNumber = mrzResult.document_number;
      docNumberConfidence = mrzResult.check_digits?.document_number ? 0.99 : 0.85;
      docNumberSource = 'MRZ';
    } else if (visualFields.passport_number) {
      finalDocNumber = visualFields.passport_series_number || visualFields.passport_number;
      docNumberConfidence = 0.85;
      docNumberSource = 'VISUAL_OCR';
    }

    if (finalDocNumber) {
      // Split series (1-2 chars) and number
      const seriesMatch = finalDocNumber.match(/^([A-ZА-Я]{1,2})([0-9]+)$/);
      const series = seriesMatch ? seriesMatch[1] : (visualFields.passport_series || 'A');
      const number = seriesMatch ? seriesMatch[2] : finalDocNumber;

      fieldsWithConfidence.passport_number = {
        value: number,
        series: series,
        full: `${series} ${number}`.trim(),
        confidence: docNumberConfidence,
        source: docNumberSource
      };
    } else {
      fieldsWithConfidence.passport_number = { value: null, confidence: 0.0, source: 'NONE' };
      warnings.push('Не удалось автоматически распознать номер паспорта');
    }

    // B. Last Name / Surname
    let lastName = null;
    let lastNameConfidence = 0.5;
    let lastNameSource = 'NONE';

    if (visualFields.last_name) {
      lastName = visualFields.last_name;
      lastNameConfidence = 0.92;
      lastNameSource = 'VISUAL_OCR';
      // Cross-check with MRZ
      if (mrzResult && mrzResult.surname_cyrillic) {
        if (mrzResult.surname_cyrillic.toLowerCase() === lastName.toLowerCase()) {
          lastNameConfidence = 0.98;
          lastNameSource = 'CROSS_VALIDATED';
        }
      }
    } else if (mrzResult && mrzResult.surname_cyrillic) {
      lastName = normalizeName(mrzResult.surname_cyrillic);
      lastNameConfidence = 0.88;
      lastNameSource = 'MRZ';
    }

    fieldsWithConfidence.last_name = {
      value: lastName,
      confidence: lastName ? lastNameConfidence : 0.0,
      source: lastNameSource
    };

    // C. First Name
    let firstName = null;
    let firstNameConfidence = 0.5;
    let firstNameSource = 'NONE';

    if (visualFields.first_name) {
      firstName = visualFields.first_name;
      firstNameConfidence = 0.92;
      firstNameSource = 'VISUAL_OCR';
      if (mrzResult && mrzResult.given_names_cyrillic) {
        const mrzFirst = mrzResult.given_names_cyrillic.split(' ')[0];
        if (mrzFirst && mrzFirst.toLowerCase() === firstName.toLowerCase()) {
          firstNameConfidence = 0.98;
          firstNameSource = 'CROSS_VALIDATED';
        }
      }
    } else if (mrzResult && mrzResult.given_names_cyrillic) {
      const parts = mrzResult.given_names_cyrillic.split(' ');
      firstName = normalizeName(parts[0]);
      firstNameConfidence = 0.88;
      firstNameSource = 'MRZ';
    }

    fieldsWithConfidence.first_name = {
      value: firstName,
      confidence: firstName ? firstNameConfidence : 0.0,
      source: firstNameSource
    };

    // D. Middle Name / Patronymic
    let middleName = null;
    let middleNameConfidence = 0.5;
    let middleNameSource = 'NONE';

    if (visualFields.middle_name) {
      middleName = visualFields.middle_name;
      middleNameConfidence = 0.88;
      middleNameSource = 'VISUAL_OCR';
    } else if (mrzResult && mrzResult.given_names_cyrillic) {
      const parts = mrzResult.given_names_cyrillic.split(' ');
      if (parts.length > 1) {
        middleName = normalizeName(parts.slice(1).join(' '));
        middleNameConfidence = 0.80;
        middleNameSource = 'MRZ';
      }
    }

    fieldsWithConfidence.middle_name = {
      value: middleName,
      confidence: middleName ? middleNameConfidence : 0.0,
      source: middleNameSource
    };

    // Full Name composite
    const fullNameParts = [lastName, firstName, middleName].filter(Boolean);
    const fullName = fullNameParts.join(' ');
    fieldsWithConfidence.full_name = {
      value: fullName || null,
      confidence: lastName && firstName ? Math.min(lastNameConfidence, firstNameConfidence) : 0.4,
      source: lastNameSource
    };

    // E. Birth Date
    let birthDate = null;
    let birthDateConfidence = 0.5;
    let birthDateSource = 'NONE';

    if (mrzResult && mrzResult.birth_date) {
      birthDate = mrzResult.birth_date;
      birthDateConfidence = mrzResult.check_digits?.birth_date ? 0.99 : 0.88;
      birthDateSource = 'MRZ';
      if (visualFields.birth_date && visualFields.birth_date === birthDate) {
        birthDateConfidence = 0.99;
        birthDateSource = 'CROSS_VALIDATED';
      } else if (visualFields.birth_date && visualFields.birth_date !== birthDate) {
        warnings.push(`Дата рождения в MRZ (${birthDate}) отличается от визуального текста (${visualFields.birth_date})`);
      }
    } else if (visualFields.birth_date) {
      birthDate = visualFields.birth_date;
      birthDateConfidence = 0.86;
      birthDateSource = 'VISUAL_OCR';
    }

    fieldsWithConfidence.birth_date = {
      value: birthDate,
      confidence: birthDate ? birthDateConfidence : 0.0,
      source: birthDateSource
    };

    // F. Issue Date
    fieldsWithConfidence.issue_date = {
      value: visualFields.issue_date || null,
      confidence: visualFields.issue_date ? 0.88 : 0.0,
      source: visualFields.issue_date ? 'VISUAL_OCR' : 'NONE'
    };

    // G. Issuing Authority
    fieldsWithConfidence.issuing_authority = {
      value: visualFields.issuing_authority || 'МВД РТ',
      confidence: visualFields.issuing_authority ? 0.85 : 0.50,
      source: visualFields.issuing_authority ? 'VISUAL_OCR' : 'DEFAULT'
    };

    // H. INN / РМА
    let inn = visualFields.inn;
    let innConfidence = 0.88;
    let innSource = 'VISUAL_OCR';

    if (!inn && mrzResult && mrzResult.personal_number && /^\d{9,12}$/.test(mrzResult.personal_number)) {
      inn = mrzResult.personal_number;
      innConfidence = 0.92;
      innSource = 'MRZ';
    }

    fieldsWithConfidence.inn = {
      value: inn || null,
      confidence: inn ? innConfidence : 0.0,
      source: inn ? innSource : 'NONE'
    };

    // I. Registration Address
    fieldsWithConfidence.address = {
      value: visualFields.address || null,
      confidence: visualFields.address ? 0.82 : 0.0,
      source: visualFields.address ? 'VISUAL_OCR' : 'NONE'
    };

    // Calculate Overall Average Confidence Score
    const scoredFields = Object.values(fieldsWithConfidence).filter(f => f.value !== null);
    const overallConfidence = scoredFields.length > 0
      ? scoredFields.reduce((acc, cur) => acc + cur.confidence, 0) / scoredFields.length
      : 0.0;

    if (overallConfidence < 0.70) {
      warnings.push('Качество распознавания ниже 70%. Пожалуйста, внимательно проверьте все поля.');
    }

    return {
      raw: rawText,
      fields: fieldsWithConfidence,
      mrz: mrzResult,
      confidence: parseFloat(overallConfidence.toFixed(2)),
      warnings: warnings
    };
  }
}
