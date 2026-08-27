import { parseMRZ, transliterateLatinToCyrillic } from './mrzParser.js';

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
  let clean = String(name).trim();

  // Strip prefix noise like "Surname:", "Given names:", "Name:", "Father's name:"
  clean = clean.replace(/^(?:surname|given\s*names?|first\s*name|name|father'?s?\s*name|patronymic|насаб|ном|номи\s*падар|фамилия|имя|отчество)\s*[:.\-]?\s*/i, '');

  // If compound like "МАЧИДОВ / MAJIDOV", take the primary Cyrillic or native part
  if (clean.includes('/')) {
    const parts = clean.split('/').map(p => p.trim().replace(/^(?:surname|given\s*names?|first\s*name|name|father'?s?\s*name|patronymic)\s*[:.\-]?\s*/i, '')).filter(Boolean);
    // Prefer Cyrillic part if available
    const cyrPart = parts.find(p => /[А-Яа-яЁёҒғӢӣҚқӮӯҲҳҶҷ]/.test(p));
    clean = cyrPart || parts[0];
  }

  return clean
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(word => word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : '')
    .join(' ');
}

export function normalizePassportNumber(num) {
  if (!num) return null;
  return String(num).toUpperCase().replace(/[^A-Z0-9А-Я]/g, '');
}

export function normalizeINN(inn) {
  if (!inn) return null;
  const digits = String(inn).replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 14 ? digits : null;
}

/**
 * Helper to check if two name variations match (handles Cyrillic/Latin transliteration and Tajik characters)
 */
export function areNamesEquivalent(nameA, nameB) {
  if (!nameA || !nameB) return false;
  const normA = nameA.toUpperCase().replace(/[\s\-/]/g, '');
  const normB = nameB.toUpperCase().replace(/[\s\-/]/g, '');

  if (normA === normB) return true;

  // Transliterate if one is Latin
  const isALatin = /^[A-Z]+$/.test(normA);
  const isBLatin = /^[A-Z]+$/.test(normB);

  let compA = isALatin ? transliterateLatinToCyrillic(normA) : normA;
  let compB = isBLatin ? transliterateLatinToCyrillic(normB) : normB;

  // Harmonize Tajik soft letters (Ҷ/Ч, Ҳ/Х, Ӯ/У, Ӣ/И, Ғ/Г, Э/Е)
  const harmonize = (str) => str
    .replace(/Ҷ/g, 'Ч')
    .replace(/Ҳ/g, 'Х')
    .replace(/Ӯ/g, 'У')
    .replace(/Ӣ/g, 'И')
    .replace(/Ғ/g, 'Г')
    .replace(/Э/g, 'Е')
    .replace(/Ё/g, 'Е')
    .replace(/J/g, 'CH');

  return harmonize(compA) === harmonize(compB);
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
  const passportRegexes = [
    /(?:рақами\s*шиноснома(?:\s*[/\\|]\s*document\s*no)?|document\s*no|паспорт\s*№|серия\s*и\s*номер|№)\s*[:.]?\s*([A-ZА-Я]{1,2})\s*([0-9]{6,8})/i,
    /(?:document\s*no|рақами\s*шиноснома)\s*[:.]?\s*([A-ZА-Я]{1,2}[0-9]{6,8})/i,
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
        const full = m[1].toUpperCase().replace(/\s/g, '');
        const seriesMatch = full.match(/^([A-ZА-Я]{1,2})([0-9]+)$/);
        if (seriesMatch) {
          fields.passport_series = seriesMatch[1];
          fields.passport_number = seriesMatch[2];
        } else {
          fields.passport_number = full;
        }
        fields.passport_series_number = full;
      }
      break;
    }
  }

  // 2. Names (Насаб / Фамилия, Ном / Имя, Номи падар / Отчество)
  const surnameRegexes = [
    /(?:^|\n|\r|[/\\])\s*(?:насаб(?:\s*[/\\|]\s*surname)?|фамилия|surname)\s*[:.\-]?\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-\s/]+?)(?=\n|\r|ном|номи|name|given|$)/i,
    /(?:^|\s)(?:насаб|фамилия|surname)\s*[:.]\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-\s/]+)/i
  ];
  for (const reg of surnameRegexes) {
    const m = fullText.match(reg);
    if (m) {
      const raw = m[1].split(/[\n\r]/)[0].trim();
      fields.last_name = normalizeName(raw);
      break;
    }
  }

  const nameRegexes = [
    /(?:^|\n|\r|[/\\])\s*(?:ном(?:\s*[/\\|]\s*(?:given\s*names?|first\s*name|name))?|номи\s*шаҳрванд|имя|given\s*names?|name)\s*[:.\-]?\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-\s/]+?)(?=\n|\r|номи\s*падар|отчество|patronymic|father|$)/i,
    /(?:^|\s)(?:ном|имя|given\s*names?)\s*[:.]\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-\s/]+)/i
  ];
  for (const reg of nameRegexes) {
    const m = fullText.match(reg);
    if (m) {
      const raw = m[1].split(/[\n\r]/)[0].trim();
      fields.first_name = normalizeName(raw);
      break;
    }
  }

  const middleNameRegexes = [
    /(?:^|\n|\r|[/\\])\s*(?:номи\s*падар(?:\s*[/\\|]\s*(?:father'?s?\s*name|patronymic))?|отчество|patronymic|father(?:'s)?\s*name)\s*[:.\-]?\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-\s/]+?)(?=\n|\r|санаи|дата|date|$)/i,
    /(?:^|\s)(?:номи\s*падар|отчество|father'?s?\s*name)\s*[:.]\s*([A-ZА-ЯЁҒӢҚӮҲҶa-zа-яёғӣқӯҳҷ\-\s/]+)/i
  ];
  for (const reg of middleNameRegexes) {
    const m = fullText.match(reg);
    if (m) {
      const raw = m[1].split(/[\n\r]/)[0].trim();
      fields.middle_name = normalizeName(raw);
      break;
    }
  }

  // 3. Dates (Санаи таваллуд, Санаи додани шиноснома, Муҳлати эътибор)
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

  const expiryDateRegexes = [
    /(?:муҳлати\s*эътибор|срок\s*действия|действителен\s*до|date\s*of\s*expiry|expiry\s*date)\s*[:.]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})/i
  ];
  for (const reg of expiryDateRegexes) {
    const m = fullText.match(reg);
    if (m) { fields.expiry_date = normalizeDate(m[1]); break; }
  }

  // 4. Issuing Authority (Мақоми додани шиноснома / Кем выдан)
  const authorityRegexes = [
    /(?:мақоми\s*додани\s*шиноснома|мақоми\s*додашуда|кем\s*выдан|паспорт\s*дода\s*шудааст|issuing\s*authority)\s*[:.]?\s*([^\n\r]+)/i,
    /(?:ШВКД\s*[^\n\r]+|МВД\s*[^\n\r]+|ОУФМС\s*[^\n\r]+|DIA\s*IN\s*[^\n\r]+)/i
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
    /(?:рма|инн|tax\s*id|tax\s*payer\s*id|рақами\s*мушаххаси\s*андозсупоранда)\s*[:.]?\s*(\d{9,12})/i,
    /\b(\d{9})\b/
  ];
  for (const reg of innRegexes) {
    const m = fullText.match(reg);
    if (m) { fields.inn = normalizeINN(m[1]); break; }
  }

  // 6. Address / Суроға / Прописка
  const addressRegexes = [
    /(?:суроға|сурога|адрес|ҷои\s*зист|прописка|место\s*жительства|address)\s*[:.]?\s*([^\n\r]+)/i
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
 * Provider-agnostic Passport OCR Service with Deep MRZ Cross-Validation
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
    let hasCriticalConflict = false;

    // 1. Convert input to text representations
    let rawText = '';
    if (typeof frontInput === 'string') {
      rawText += frontInput + '\n';
    }
    if (typeof backInput === 'string') {
      rawText += backInput + '\n';
    }

    // 2. Run ICAO 9303 MRZ Engine (MRZ is absolute source of truth if valid)
    const mrzResult = parseMRZ(rawText);
    const isMrzValid = Boolean(mrzResult && mrzResult.is_valid);

    // 3. Run visual regex pattern extraction
    const visualFields = extractFieldsFromText(rawText);

    // 4. Merge and cross-validate MRZ + Visual fields

    // --- A. Passport Number / Series ---
    let finalDocNumber = null;
    let docNumberSeries = 'A';
    let docNumberVal = null;
    let docNumberConfidence = 0.5;
    let docNumberSource = 'NONE';
    let docNumberConflict = false;
    let visualDocNum = visualFields.passport_series_number || visualFields.passport_number || null;

    if (mrzResult && mrzResult.document_number) {
      finalDocNumber = mrzResult.document_number;
      docNumberConfidence = mrzResult.check_digits?.document_number ? 0.99 : 0.88;
      docNumberSource = 'MRZ';

      if (visualDocNum) {
        const normVisual = normalizePassportNumber(visualDocNum);
        const normMrz = normalizePassportNumber(finalDocNumber);
        if (normVisual === normMrz) {
          docNumberConfidence = 0.99;
          docNumberSource = 'CROSS_VALIDATED';
        } else {
          docNumberConflict = true;
          hasCriticalConflict = true;
          docNumberConfidence = 0.40;
          warnings.push(`Критический конфликт номера паспорта: MRZ (${normMrz}) отличается от визуального текста (${normVisual})`);
        }
      }
    } else if (visualDocNum) {
      finalDocNumber = visualDocNum;
      docNumberConfidence = 0.85;
      docNumberSource = 'VISUAL_OCR';
    }

    if (finalDocNumber) {
      const norm = normalizePassportNumber(finalDocNumber);
      const seriesMatch = norm.match(/^([A-ZА-Я]{1,2})([0-9]+)$/);
      docNumberSeries = seriesMatch ? seriesMatch[1] : (visualFields.passport_series || 'A');
      docNumberVal = seriesMatch ? seriesMatch[2] : norm;

      fieldsWithConfidence.passport_number = {
        value: docNumberVal,
        series: docNumberSeries,
        full: `${docNumberSeries} ${docNumberVal}`.trim(),
        confidence: docNumberConfidence,
        source: docNumberSource,
        mrz_value: mrzResult?.document_number || null,
        ocr_value: visualDocNum,
        conflict: docNumberConflict
      };
    } else {
      fieldsWithConfidence.passport_number = { value: null, confidence: 0.0, source: 'NONE', conflict: false };
      warnings.push('Не удалось распознать номер паспорта');
    }

    // --- B. Last Name / Surname ---
    let lastName = null;
    let lastNameConfidence = 0.5;
    let lastNameSource = 'NONE';
    let lastNameConflict = false;

    if (mrzResult && (mrzResult.surname || mrzResult.surname_cyrillic)) {
      // MRZ is trusted source of truth
      const mrzCyr = mrzResult.surname_cyrillic || transliterateLatinToCyrillic(mrzResult.surname);
      lastName = visualFields.last_name && areNamesEquivalent(visualFields.last_name, mrzCyr)
        ? visualFields.last_name
        : normalizeName(mrzCyr);

      lastNameConfidence = isMrzValid ? 0.96 : 0.88;
      lastNameSource = 'MRZ';

      if (visualFields.last_name) {
        if (areNamesEquivalent(visualFields.last_name, mrzCyr)) {
          lastNameConfidence = 0.99;
          lastNameSource = 'CROSS_VALIDATED';
        } else {
          lastNameConflict = true;
          hasCriticalConflict = true;
          lastNameConfidence = 0.40;
          warnings.push(`Критический конфликт фамилии: MRZ (${mrzResult.surname}) отличается от текста (${visualFields.last_name})`);
        }
      }
    } else if (visualFields.last_name) {
      lastName = visualFields.last_name;
      lastNameConfidence = 0.88;
      lastNameSource = 'VISUAL_OCR';
    }

    fieldsWithConfidence.last_name = {
      value: lastName,
      confidence: lastName ? lastNameConfidence : 0.0,
      source: lastNameSource,
      mrz_value: mrzResult?.surname || null,
      ocr_value: visualFields.last_name || null,
      conflict: lastNameConflict
    };

    // --- C. First Name ---
    let firstName = null;
    let firstNameConfidence = 0.5;
    let firstNameSource = 'NONE';
    let firstNameConflict = false;

    if (mrzResult && (mrzResult.given_names || mrzResult.given_names_cyrillic)) {
      const mrzFirstCyr = (mrzResult.given_names_cyrillic || transliterateLatinToCyrillic(mrzResult.given_names)).split(' ')[0];
      firstName = visualFields.first_name && areNamesEquivalent(visualFields.first_name, mrzFirstCyr)
        ? visualFields.first_name
        : normalizeName(mrzFirstCyr);

      firstNameConfidence = isMrzValid ? 0.96 : 0.88;
      firstNameSource = 'MRZ';

      if (visualFields.first_name) {
        if (areNamesEquivalent(visualFields.first_name, mrzFirstCyr)) {
          firstNameConfidence = 0.99;
          firstNameSource = 'CROSS_VALIDATED';
        } else {
          firstNameConflict = true;
          hasCriticalConflict = true;
          firstNameConfidence = 0.40;
          warnings.push(`Критический конфликт имени: MRZ (${mrzResult.given_names}) отличается от текста (${visualFields.first_name})`);
        }
      }
    } else if (visualFields.first_name) {
      firstName = visualFields.first_name;
      firstNameConfidence = 0.88;
      firstNameSource = 'VISUAL_OCR';
    }

    fieldsWithConfidence.first_name = {
      value: firstName,
      confidence: firstName ? firstNameConfidence : 0.0,
      source: firstNameSource,
      mrz_value: mrzResult?.given_names || null,
      ocr_value: visualFields.first_name || null,
      conflict: firstNameConflict
    };

    // --- D. Middle Name / Father Name ---
    let middleName = null;
    let middleNameConfidence = 0.5;
    let middleNameSource = 'NONE';

    if (visualFields.middle_name) {
      middleName = visualFields.middle_name;
      middleNameConfidence = 0.90;
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
      source: middleNameSource,
      conflict: false
    };

    // Full Name composite
    const fullNameParts = [lastName, firstName, middleName].filter(Boolean);
    const fullName = fullNameParts.join(' ');
    fieldsWithConfidence.full_name = {
      value: fullName || null,
      confidence: lastName && firstName ? Math.min(lastNameConfidence, firstNameConfidence) : 0.4,
      source: lastNameSource,
      conflict: lastNameConflict || firstNameConflict
    };

    // --- E. Birth Date ---
    let birthDate = null;
    let birthDateConfidence = 0.5;
    let birthDateSource = 'NONE';
    let birthDateConflict = false;

    if (mrzResult && mrzResult.birth_date) {
      birthDate = mrzResult.birth_date;
      birthDateConfidence = mrzResult.check_digits?.birth_date ? 0.99 : 0.88;
      birthDateSource = 'MRZ';

      if (visualFields.birth_date) {
        if (visualFields.birth_date === birthDate) {
          birthDateConfidence = 0.99;
          birthDateSource = 'CROSS_VALIDATED';
        } else {
          birthDateConflict = true;
          hasCriticalConflict = true;
          birthDateConfidence = 0.40;
          warnings.push(`Критический конфликт даты рождения: MRZ (${birthDate}) отличается от текста (${visualFields.birth_date})`);
        }
      }
    } else if (visualFields.birth_date) {
      birthDate = visualFields.birth_date;
      birthDateConfidence = 0.86;
      birthDateSource = 'VISUAL_OCR';
    }

    fieldsWithConfidence.birth_date = {
      value: birthDate,
      confidence: birthDate ? birthDateConfidence : 0.0,
      source: birthDateSource,
      mrz_value: mrzResult?.birth_date || null,
      ocr_value: visualFields.birth_date || null,
      conflict: birthDateConflict
    };

    // --- F. Issue Date ---
    fieldsWithConfidence.issue_date = {
      value: visualFields.issue_date || null,
      confidence: visualFields.issue_date ? 0.88 : 0.0,
      source: visualFields.issue_date ? 'VISUAL_OCR' : 'NONE',
      conflict: false
    };

    // --- G. Expiry Date ---
    let expiryDate = mrzResult?.expiry_date || visualFields.expiry_date || null;
    fieldsWithConfidence.expiry_date = {
      value: expiryDate,
      confidence: expiryDate ? (mrzResult?.check_digits?.expiry_date ? 0.99 : 0.88) : 0.0,
      source: mrzResult?.expiry_date ? 'MRZ' : (visualFields.expiry_date ? 'VISUAL_OCR' : 'NONE'),
      conflict: false
    };

    // --- H. Issuing Authority ---
    fieldsWithConfidence.issuing_authority = {
      value: visualFields.issuing_authority || null,
      confidence: visualFields.issuing_authority ? 0.90 : 0.0,
      source: visualFields.issuing_authority ? 'VISUAL_OCR' : 'NONE',
      conflict: false
    };

    // --- I. INN / Tax ID ---
    let inn = visualFields.inn;
    let innConfidence = 0.90;
    let innSource = 'VISUAL_OCR';

    if (!inn && mrzResult && mrzResult.personal_number && /^\d{9,12}$/.test(mrzResult.personal_number)) {
      inn = mrzResult.personal_number;
      innConfidence = 0.95;
      innSource = 'MRZ';
    }

    fieldsWithConfidence.inn = {
      value: inn || null,
      confidence: inn ? innConfidence : 0.0,
      source: inn ? innSource : 'NONE',
      conflict: false
    };

    // --- J. Registration Address ---
    fieldsWithConfidence.address = {
      value: visualFields.address || null,
      confidence: visualFields.address ? 0.88 : 0.0,
      source: visualFields.address ? 'VISUAL_OCR' : 'NONE',
      conflict: false
    };

    // Calculate Overall Confidence Score
    const scoredFields = Object.values(fieldsWithConfidence).filter(f => f.value !== null);
    const overallConfidence = scoredFields.length > 0
      ? scoredFields.reduce((acc, cur) => acc + cur.confidence, 0) / scoredFields.length
      : 0.0;

    // Status Determination
    let status = 'SUCCESS';
    if (hasCriticalConflict) {
      status = 'CRITICAL_CONFLICT';
    } else if (warnings.length > 0 || overallConfidence < 0.85 || !isMrzValid) {
      status = 'REVIEW_REQUIRED';
    }

    if (hasCriticalConflict) {
      warnings.unshift('ВНИМАНИЕ: Обнаружены критические несовпадения между строками MRZ и распознанным текстом. Подтверждение заблокировано до ручной проверки.');
    }

    return {
      status,
      has_critical_conflict: hasCriticalConflict,
      confirmation_blocked: hasCriticalConflict,
      raw: rawText,
      fields: fieldsWithConfidence,
      mrz: mrzResult,
      confidence: parseFloat(overallConfidence.toFixed(2)),
      warnings: warnings
    };
  }
}
