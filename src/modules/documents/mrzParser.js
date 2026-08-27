/**
 * ICAO Doc 9303 Machine Readable Zone (MRZ) Parser
 * Compliant with TD1 (3x30), TD2 (2x36), and TD3 (2x44) standards.
 * Supports biometric passports (P<TJK...), national ID cards (I<TJK...), and CIS travel documents.
 */

const WEIGHTS = [7, 3, 1];

/**
 * Convert character to numeric value per ICAO 9303 rules
 * 0-9 -> 0-9
 * A-Z -> 10-35
 * < -> 0
 */
export function getCharValue(char) {
  if (!char || char === '<') return 0;
  const code = char.charCodeAt(0);
  if (code >= 48 && code <= 57) {
    return code - 48; // 0-9
  }
  if (code >= 65 && code <= 90) {
    return code - 55; // A=10, B=11 ... Z=35
  }
  if (code >= 97 && code <= 122) {
    return code - 87; // lowercase fallback
  }
  return 0;
}

/**
 * Calculate ICAO 9303 check digit using weights [7, 3, 1]
 */
export function calculateCheckDigit(str) {
  if (!str) return '0';
  let sum = 0;
  for (let i = 0; i < str.length; i++) {
    const val = getCharValue(str[i]);
    const weight = WEIGHTS[i % 3];
    sum += val * weight;
  }
  return String(sum % 10);
}

/**
 * Verify check digit
 */
export function verifyCheckDigit(str, expectedDigit) {
  const calculated = calculateCheckDigit(str);
  return calculated === String(expectedDigit);
}

/**
 * Parse date in YYMMDD format to YYYY-MM-DD
 * @param {string} yymmdd 
 * @param {boolean} isExpiry If true, assumes future dates in 2000s; if false (birth date), uses cutoff
 */
export function parseMrzDate(yymmdd, isExpiry = false) {
  if (!yymmdd || yymmdd.length !== 6 || !/^\d{6}$/.test(yymmdd)) {
    return null;
  }
  const yy = parseInt(yymmdd.substring(0, 2), 10);
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);

  const currentYear = new Date().getFullYear();
  const currentYY = currentYear % 100;

  let fullYear;
  if (isExpiry) {
    // Expiry dates are typically in current or future years (2000+)
    fullYear = 2000 + yy;
  } else {
    // Birth dates: if YY > currentYY, assume 1900s, else 2000s
    if (yy > currentYY) {
      fullYear = 1900 + yy;
    } else {
      fullYear = 2000 + yy;
    }
  }

  // Validate month and day bounds
  const monthNum = parseInt(mm, 10);
  const dayNum = parseInt(dd, 10);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) {
    return null;
  }

  return `${fullYear}-${mm}-${dd}`;
}

/**
 * Clean and format name parts from MRZ (replacing '<' with spaces)
 */
export function cleanMrzString(str) {
  if (!str) return '';
  return str.replace(/<+/g, ' ').trim();
}

/**
 * Transliterate Latin characters from MRZ into Cyrillic (standard Tajik/Russian transliteration)
 */
export function transliterateLatinToCyrillic(latinStr) {
  if (!latinStr) return '';
  const map = {
    'SH': 'Ш', 'CH': 'Ч', 'ZH': 'Ж', 'KH': 'Х', 'TS': 'Ц', 'YU': 'Ю', 'YA': 'Я', 'GH': 'Ғ', 'Q': 'Қ', 'J': 'Ҷ',
    'A': 'А', 'B': 'Б', 'V': 'В', 'G': 'Г', 'D': 'Д', 'E': 'Е', 'Z': 'З', 'I': 'И', 'Y': 'Й', 'K': 'К',
    'L': 'Л', 'M': 'М', 'N': 'Н', 'O': 'О', 'P': 'П', 'R': 'Р', 'S': 'С', 'T': 'Т', 'U': 'У', 'F': 'Ф',
    'H': 'Ҳ', 'C': 'Ц', 'X': 'Х'
  };

  let res = latinStr.toUpperCase();
  // Replace digraphs first
  for (const [lat, cyr] of Object.entries(map)) {
    if (lat.length === 2) {
      res = res.replaceAll(lat, cyr);
    }
  }
  for (const [lat, cyr] of Object.entries(map)) {
    if (lat.length === 1) {
      res = res.replaceAll(lat, cyr);
    }
  }
  return res;
}

/**
 * Main MRZ Parser supporting TD1, TD2, TD3
 * @param {string[]|string} lines Lines of MRZ
 */
export function parseMRZ(rawInput) {
  if (!rawInput) return null;

  // Clean lines: uppercase, remove spaces, filter non-empty
  let lines = [];
  if (Array.isArray(rawInput)) {
    lines = rawInput.map(l => l.toUpperCase().replace(/[\s\r\n]+/g, '')).filter(l => l.length >= 20);
  } else if (typeof rawInput === 'string') {
    lines = rawInput
      .split(/[\r\n]+/)
      .map(l => l.toUpperCase().replace(/[\s\r\n]+/g, ''))
      .filter(l => l.length >= 20);
  }

  if (lines.length === 0) return null;

  // Find candidate MRZ lines
  // Filter for lines containing '<' characters typical of MRZ
  const mrzLines = lines.filter(l => (l.match(/</g) || []).length >= 2);

  if (mrzLines.length >= 2) {
    // Check TD3 (2 lines of 44 chars)
    if (mrzLines.length === 2 && mrzLines[0].length >= 40 && mrzLines[1].length >= 40) {
      return parseTD3(mrzLines[0].padEnd(44, '<').substring(0, 44), mrzLines[1].padEnd(44, '<').substring(0, 44));
    }

    // Check TD1 (3 lines of 30 chars - ID cards)
    if (mrzLines.length >= 3 && mrzLines[0].length >= 28 && mrzLines[1].length >= 28 && mrzLines[2].length >= 28) {
      return parseTD1(
        mrzLines[0].padEnd(30, '<').substring(0, 30),
        mrzLines[1].padEnd(30, '<').substring(0, 30),
        mrzLines[2].padEnd(30, '<').substring(0, 30)
      );
    }

    // Check TD2 (2 lines of 36 chars)
    if (mrzLines.length === 2 && mrzLines[0].length >= 34 && mrzLines[1].length >= 34) {
      return parseTD2(mrzLines[0].padEnd(36, '<').substring(0, 36), mrzLines[1].padEnd(36, '<').substring(0, 36));
    }
  }

  // Fallback: search for TD3 pattern in the stream
  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i];
    const l2 = lines[i + 1];
    if (l1.startsWith('P<') || l1.startsWith('P') || l1.startsWith('I<') || l1.startsWith('I')) {
      if (l1.length >= 40 && l2.length >= 40) {
        return parseTD3(l1.padEnd(44, '<').substring(0, 44), l2.padEnd(44, '<').substring(0, 44));
      }
    }
  }

  return null;
}

/**
 * Parse TD3 (Passport - 2 lines of 44 characters)
 * Line 1: P<ISSLASTNAME<<FIRSTNAME<MIDDLENAME<<<<<<<<<<<<
 * Line 2: DOCNUM<0NATYYMMDDFYYMMDDE<<<<<<<<<<<<<<0
 */
function parseTD3(line1, line2) {
  const documentType = line1.substring(0, 2).replace(/</g, '');
  const issuingCountry = line1.substring(2, 5).replace(/</g, '');

  // Extract names
  const nameSection = line1.substring(5);
  const nameParts = nameSection.split('<<');
  const surname = cleanMrzString(nameParts[0]);
  const givenNames = nameParts.length > 1 ? cleanMrzString(nameParts.slice(1).join(' ')) : '';

  // Line 2 data
  const rawDocNumber = line2.substring(0, 9);
  const docNumber = rawDocNumber.replace(/</g, '');
  const docNumberCheck = line2[9];
  const isDocNumberValid = verifyCheckDigit(rawDocNumber, docNumberCheck);

  const nationality = line2.substring(10, 13).replace(/</g, '');

  const rawBirthDate = line2.substring(13, 19);
  const birthDateCheck = line2[19];
  const isBirthDateValid = verifyCheckDigit(rawBirthDate, birthDateCheck);
  const birthDate = parseMrzDate(rawBirthDate, false);

  const sex = line2[20] === 'M' ? 'MALE' : line2[20] === 'F' ? 'FEMALE' : 'UNSPECIFIED';

  const rawExpiryDate = line2.substring(21, 27);
  const expiryDateCheck = line2[27];
  const isExpiryDateValid = verifyCheckDigit(rawExpiryDate, expiryDateCheck);
  const expiryDate = parseMrzDate(rawExpiryDate, true);

  const optionalData = line2.substring(28, 42).replace(/</g, '');
  const compositeCheck = line2[43];

  // Calculate composite check string: docNum + check + birth + check + expiry + check + optional
  const compositeStr = line2.substring(0, 10) + line2.substring(13, 20) + line2.substring(21, 43);
  const isCompositeValid = verifyCheckDigit(compositeStr, compositeCheck);

  const overallValid = isDocNumberValid && isBirthDateValid && isExpiryDateValid;

  return {
    format: 'TD3',
    document_type: documentType || 'PASSPORT',
    issuing_country: issuingCountry,
    surname: surname,
    given_names: givenNames,
    full_name: `${surname} ${givenNames}`.trim(),
    surname_cyrillic: transliterateLatinToCyrillic(surname),
    given_names_cyrillic: transliterateLatinToCyrillic(givenNames),
    full_name_cyrillic: `${transliterateLatinToCyrillic(surname)} ${transliterateLatinToCyrillic(givenNames)}`.trim(),
    document_number: docNumber,
    nationality: nationality,
    birth_date: birthDate,
    sex: sex,
    expiry_date: expiryDate,
    personal_number: optionalData || null,
    check_digits: {
      document_number: isDocNumberValid,
      birth_date: isBirthDateValid,
      expiry_date: isExpiryDateValid,
      composite: isCompositeValid
    },
    is_valid: overallValid,
    raw_lines: [line1, line2]
  };
}

/**
 * Parse TD1 (National ID Card - 3 lines of 30 characters)
 */
function parseTD1(line1, line2, line3) {
  const documentType = line1.substring(0, 2).replace(/</g, '');
  const issuingCountry = line1.substring(2, 5).replace(/</g, '');

  const rawDocNumber = line1.substring(5, 14);
  const docNumber = rawDocNumber.replace(/</g, '');
  const docNumberCheck = line1[14];
  const isDocNumberValid = verifyCheckDigit(rawDocNumber, docNumberCheck);
  const optionalData1 = line1.substring(15, 30).replace(/</g, '');

  // Line 2
  const rawBirthDate = line2.substring(0, 6);
  const birthDateCheck = line2[6];
  const isBirthDateValid = verifyCheckDigit(rawBirthDate, birthDateCheck);
  const birthDate = parseMrzDate(rawBirthDate, false);

  const sex = line2[7] === 'M' ? 'MALE' : line2[7] === 'F' ? 'FEMALE' : 'UNSPECIFIED';

  const rawExpiryDate = line2.substring(8, 14);
  const expiryDateCheck = line2[14];
  const isExpiryDateValid = verifyCheckDigit(rawExpiryDate, expiryDateCheck);
  const expiryDate = parseMrzDate(rawExpiryDate, true);

  const nationality = line2.substring(15, 18).replace(/</g, '');
  const optionalData2 = line2.substring(18, 29).replace(/</g, '');

  // Line 3: Names
  const nameParts = line3.split('<<');
  const surname = cleanMrzString(nameParts[0]);
  const givenNames = nameParts.length > 1 ? cleanMrzString(nameParts.slice(1).join(' ')) : '';

  const overallValid = isDocNumberValid && isBirthDateValid && isExpiryDateValid;

  return {
    format: 'TD1',
    document_type: documentType || 'ID_CARD',
    issuing_country: issuingCountry,
    surname: surname,
    given_names: givenNames,
    full_name: `${surname} ${givenNames}`.trim(),
    surname_cyrillic: transliterateLatinToCyrillic(surname),
    given_names_cyrillic: transliterateLatinToCyrillic(givenNames),
    full_name_cyrillic: `${transliterateLatinToCyrillic(surname)} ${transliterateLatinToCyrillic(givenNames)}`.trim(),
    document_number: docNumber,
    nationality: nationality,
    birth_date: birthDate,
    sex: sex,
    expiry_date: expiryDate,
    personal_number: optionalData1 || optionalData2 || null,
    check_digits: {
      document_number: isDocNumberValid,
      birth_date: isBirthDateValid,
      expiry_date: isExpiryDateValid
    },
    is_valid: overallValid,
    raw_lines: [line1, line2, line3]
  };
}

/**
 * Parse TD2 (2 lines of 36 characters)
 */
function parseTD2(line1, line2) {
  const documentType = line1.substring(0, 2).replace(/</g, '');
  const issuingCountry = line1.substring(2, 5).replace(/</g, '');

  const nameParts = line1.substring(5).split('<<');
  const surname = cleanMrzString(nameParts[0]);
  const givenNames = nameParts.length > 1 ? cleanMrzString(nameParts.slice(1).join(' ')) : '';

  const rawDocNumber = line2.substring(0, 9);
  const docNumber = rawDocNumber.replace(/</g, '');
  const docNumberCheck = line2[9];
  const isDocNumberValid = verifyCheckDigit(rawDocNumber, docNumberCheck);

  const nationality = line2.substring(10, 13).replace(/</g, '');
  const rawBirthDate = line2.substring(13, 19);
  const birthDate = parseMrzDate(rawBirthDate, false);
  const sex = line2[20] === 'M' ? 'MALE' : line2[20] === 'F' ? 'FEMALE' : 'UNSPECIFIED';
  const rawExpiryDate = line2.substring(21, 27);
  const expiryDate = parseMrzDate(rawExpiryDate, true);

  return {
    format: 'TD2',
    document_type: documentType,
    issuing_country: issuingCountry,
    surname: surname,
    given_names: givenNames,
    full_name: `${surname} ${givenNames}`.trim(),
    surname_cyrillic: transliterateLatinToCyrillic(surname),
    given_names_cyrillic: transliterateLatinToCyrillic(givenNames),
    full_name_cyrillic: `${transliterateLatinToCyrillic(surname)} ${transliterateLatinToCyrillic(givenNames)}`.trim(),
    document_number: docNumber,
    nationality: nationality,
    birth_date: birthDate,
    sex: sex,
    expiry_date: expiryDate,
    check_digits: {
      document_number: isDocNumberValid
    },
    is_valid: isDocNumberValid,
    raw_lines: [line1, line2]
  };
}
