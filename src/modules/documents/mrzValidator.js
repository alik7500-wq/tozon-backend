/**
 * Deterministic ICAO 9303 MRZ Checksum & Parsing Utility
 */

const WEIGHTS = [7, 3, 1];

function getCharWeight(ch) {
  if (ch === '<') return 0;
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55;
  if (ch >= 'a' && ch <= 'z') return ch.toUpperCase().charCodeAt(0) - 55;
  return 0;
}

export function computeCheckDigit(str) {
  if (!str) return 0;
  let total = 0;
  for (let i = 0; i < str.length; i++) {
    total += getCharWeight(str[i]) * WEIGHTS[i % 3];
  }
  return total % 10;
}

export function verifyCheckDigit(str, expectedDigit) {
  if (!str || expectedDigit === undefined || expectedDigit === null) return false;
  const computed = computeCheckDigit(str);
  const expected = parseInt(String(expectedDigit).trim(), 10);
  return computed === expected;
}

function parseMRZDate(dateStr, isExpiry = false) {
  if (!dateStr || dateStr.length !== 6 || !/^\d{6}$/.test(dateStr)) return null;
  const yy = parseInt(dateStr.substring(0, 2), 10);
  const mm = dateStr.substring(2, 4);
  const dd = dateStr.substring(4, 6);
  
  const currentYY = new Date().getFullYear() % 100;
  let fullYear;
  if (isExpiry) {
    fullYear = (yy <= currentYY + 50 ? 2000 : 1900) + yy;
  } else {
    fullYear = (yy > currentYY ? 1900 : 2000) + yy;
  }
  
  return `${fullYear}-${mm}-${dd}`;
}

export function parseAndValidateMRZ({ line1, line2, line3 }) {
  const clean1 = (line1 || '').replace(/\s+/g, '').toUpperCase();
  const clean2 = (line2 || '').replace(/\s+/g, '').toUpperCase();
  const clean3 = (line3 || '').replace(/\s+/g, '').toUpperCase();

  const result = {
    valid: false,
    format: null,
    document_number: null,
    document_number_valid: false,
    birth_date: null,
    birth_date_valid: false,
    expiry_date: null,
    expiry_date_valid: false,
    sex: null,
    nationality: null,
    surname: null,
    given_name: null,
    overall_checksum_valid: false
  };

  // TD3: Passport (2 lines of 44 characters)
  if (clean1.length >= 44 && clean2.length >= 44) {
    result.format = 'TD3';
    
    // Line 1: Type(2), Country(3), Name(39)
    const country = clean1.substring(2, 5).replace(/</g, '');
    const namePart = clean1.substring(5, 44);
    const nameParts = namePart.split('<<');
    const surname = nameParts[0] ? nameParts[0].replace(/</g, ' ').trim() : null;
    const givenName = nameParts[1] ? nameParts[1].replace(/</g, ' ').trim() : null;

    // Line 2: DocNum(9), DocCheck(1), Nat(3), DOB(6), DOBCheck(1), Sex(1), Exp(6), ExpCheck(1), Opt(14), OptCheck(1), CompositeCheck(1)
    const docNum = clean2.substring(0, 9).replace(/</g, '');
    const docCheck = clean2[9];
    const nationality = clean2.substring(10, 13).replace(/</g, '');
    const dobStr = clean2.substring(13, 19);
    const dobCheck = clean2[19];
    const sexChar = clean2[20];
    const expStr = clean2.substring(21, 27);
    const expCheck = clean2[27];

    result.document_number = docNum || null;
    result.document_number_valid = verifyCheckDigit(clean2.substring(0, 9), docCheck);
    result.birth_date = parseMRZDate(dobStr, false);
    result.birth_date_valid = verifyCheckDigit(dobStr, dobCheck);
    result.expiry_date = parseMRZDate(expStr, true);
    result.expiry_date_valid = verifyCheckDigit(expStr, expCheck);
    result.sex = sexChar === 'M' ? 'M' : sexChar === 'F' ? 'F' : null;
    result.nationality = nationality || country || null;
    result.surname = surname || null;
    result.given_name = givenName || null;
    result.valid = result.document_number_valid || result.birth_date_valid || result.expiry_date_valid;
    return result;
  }

  // TD1: ID Card (3 lines of 30 characters)
  if (clean1.length >= 30 && clean2.length >= 30 && clean3.length >= 30) {
    result.format = 'TD1';
    
    // Line 1: Type(2), Country(3), DocNum(9), Check(1), Opt(15)
    const docNum = clean1.substring(5, 14).replace(/</g, '');
    const docCheck = clean1[14];

    // Line 2: DOB(6), DOBCheck(1), Sex(1), Exp(6), ExpCheck(1), Nat(3), Opt(11), CompCheck(1)
    const dobStr = clean2.substring(0, 6);
    const dobCheck = clean2[6];
    const sexChar = clean2[7];
    const expStr = clean2.substring(8, 14);
    const expCheck = clean2[14];
    const nationality = clean2.substring(15, 18).replace(/</g, '');

    // Line 3: Name(30)
    const nameParts = clean3.split('<<');
    const surname = nameParts[0] ? nameParts[0].replace(/</g, ' ').trim() : null;
    const givenName = nameParts[1] ? nameParts[1].replace(/</g, ' ').trim() : null;

    result.document_number = docNum || null;
    result.document_number_valid = verifyCheckDigit(clean1.substring(5, 14), docCheck);
    result.birth_date = parseMRZDate(dobStr);
    result.birth_date_valid = verifyCheckDigit(dobStr, dobCheck);
    result.expiry_date = parseMRZDate(expStr);
    result.expiry_date_valid = verifyCheckDigit(expStr, expCheck);
    result.sex = sexChar === 'M' ? 'M' : sexChar === 'F' ? 'F' : null;
    result.nationality = nationality || null;
    result.surname = surname || null;
    result.given_name = givenName || null;
    result.valid = result.document_number_valid || result.birth_date_valid || result.expiry_date_valid;
    return result;
  }

  return result;
}
