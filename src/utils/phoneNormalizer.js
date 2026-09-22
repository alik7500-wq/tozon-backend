/**
 * Utility for normalizing and validating phone numbers for SMS transmission.
 * Target standard for Tajikistan: +992XXXXXXXXX (12 characters total).
 */

export function normalizePhoneNumber(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return {
      isValid: false,
      normalized: null,
      error: 'Телефонный номер не указан или имеет неверный тип'
    };
  }

  // Trim whitespace
  const trimmed = rawPhone.trim();
  
  // Remove spaces, hyphens, parentheses, dots
  let cleaned = trimmed.replace(/[\s\-\(\)\.]/g, '');

  // If starts with 8992 or 00992, standardize to +992
  if (cleaned.startsWith('00992')) {
    cleaned = '+' + cleaned.slice(2);
  } else if (cleaned.startsWith('8992')) {
    cleaned = '+' + cleaned.slice(1);
  }

  // If no leading '+', check digits count
  if (!cleaned.startsWith('+')) {
    // Digits only
    const digitsOnly = cleaned.replace(/\D/g, '');
    
    if (digitsOnly.length === 9) {
      // 9-digit local Tajik subscriber number (e.g. 927779757)
      cleaned = '+992' + digitsOnly;
    } else if (digitsOnly.length === 12 && digitsOnly.startsWith('992')) {
      // 12-digit number starting with 992 without '+'
      cleaned = '+' + digitsOnly;
    } else if (digitsOnly.length === 10 && digitsOnly.startsWith('0')) {
      // 10-digit number starting with 0 (e.g. 0927779757)
      cleaned = '+992' + digitsOnly.slice(1);
    } else {
      // Fallback: prepend '+' if digits only
      cleaned = '+' + digitsOnly;
    }
  } else {
    // Keep '+' and retain only digits after '+'
    cleaned = '+' + cleaned.slice(1).replace(/\D/g, '');
  }

  // Specific validation for Tajikistan numbers: +992 followed by 9 digits
  const tajikRegex = /^\+992[0-9]{9}$/;
  // General international validation as fallback (E.164 standard)
  const internationalRegex = /^\+[1-9][0-9]{7,14}$/;

  if (tajikRegex.test(cleaned)) {
    return {
      isValid: true,
      normalized: cleaned,
      country: 'TJ',
      error: null
    };
  } else if (internationalRegex.test(cleaned)) {
    return {
      isValid: true,
      normalized: cleaned,
      country: 'INTL',
      error: null
    };
  }

  return {
    isValid: false,
    normalized: null,
    error: `Недопустимый формат телефонного номера: ${rawPhone}`
  };
}
