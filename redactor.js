// redactor.js — core redaction engine, no DOM dependencies.
// Shared between popup.js and background.js (service worker).

(function (global) {
  'use strict';

  // Maps lowercase JSON-key names (after stripping non-alphanumerics)
  // to canonical tag names. Anything not in the map falls back to a
  // camelCase → SCREAMING_SNAKE conversion of the original key.
  const KEY_TAG_ALIASES = {
    mobile: 'PHONE', mobilenumber: 'PHONE', phonenumber: 'PHONE',
    emailaddress: 'EMAIL',
    streetaddress: 'STREET_ADDRESS', propertyaddress: 'PROPERTY_ADDRESS',
    cardnumber: 'CARD_NUMBER', creditcard: 'CARD_NUMBER',
    cvc: 'CVV',
    guestname: 'GUEST_NAME', customername: 'CUSTOMER_NAME',
    tenantname: 'TENANT_NAME', propertyname: 'PROPERTY_NAME',
    unitname: 'UNIT_NAME', unitnumber: 'UNIT_NUMBER', roomnumber: 'ROOM_NUMBER',
    reservationid: 'RESERVATION_ID', confirmationnumber: 'CONFIRMATION_NUMBER',
    bookingid: 'BOOKING_ID', invoicenumber: 'INVOICE_NUMBER',
    orderid: 'ORDER_ID', accountnumber: 'ACCOUNT_NUMBER',
    policynumber: 'POLICY_NUMBER',
    cardexpiry: 'CARD_EXPIRY', expiry: 'CARD_EXPIRY', expirydate: 'CARD_EXPIRY',
    checkin: 'CHECK_IN_DATE', checkout: 'CHECK_OUT_DATE',
    checkindate: 'CHECK_IN_DATE', checkoutdate: 'CHECK_OUT_DATE',
    licensenumber: 'LICENSE_NUMBER', platenumber: 'PLATE_NUMBER',
    gstnumber: 'GST', pannumber: 'PAN', taxid: 'TAX_ID',
    firstname: 'FIRST_NAME', lastname: 'LAST_NAME', fullname: 'FULL_NAME',
    birthdate: 'DOB', birthday: 'DOB',
    routingnumber: 'ROUTING_NUMBER',
    apikey: 'API_KEY', apisecret: 'API_SECRET',
    accesstoken: 'ACCESS_TOKEN', refreshtoken: 'REFRESH_TOKEN',
    clientsecret: 'CLIENT_SECRET',
    zipcode: 'ZIP', postcode: 'POSTAL', pincode: 'POSTAL',
    lat: 'LATITUDE', lng: 'LONGITUDE', lon: 'LONGITUDE',
    coords: 'COORDINATES',
  };

  // At soft level, only the keys in this set get value-masked. Less-critical
  // structured fields (location, addresses, reservation/order IDs, person
  // names) stay visible at soft and are only masked at medium+. The line is
  // drawn at "could uniquely identify or authorize someone" vs. "context
  // that's mildly sensitive but rarely actionable alone."
  const HIGH_SENSITIVITY_KEYS = new Set([
    // credentials / secrets
    'password', 'passcode', 'pin', 'secret', 'token',
    'apikey', 'apisecret', 'accesstoken', 'refreshtoken', 'clientsecret',
    // financial
    'cardnumber', 'creditcard', 'cvv', 'cvc',
    'cardexpiry', 'expiry', 'expirydate',
    'iban', 'swift', 'routingnumber', 'accountnumber',
    // government / national IDs
    'ssn', 'passport', 'aadhaar', 'taxid', 'pannumber', 'gstnumber',
    'nationalid', 'licensenumber',
    // identity contact (uniquely identifying)
    'email', 'emailaddress',
    'phone', 'phonenumber', 'mobile', 'mobilenumber',
    // birth dates
    'dob', 'birthdate', 'birthday',
  ]);

  function keyToTag(rawKey) {
    const norm = rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (KEY_TAG_ALIASES[norm]) return KEY_TAG_ALIASES[norm];
    // camelCase / PascalCase → SCREAMING_SNAKE
    return rawKey
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .toUpperCase();
  }

  function labeledReplace(match, hard) {
    const colon = match.indexOf(':');
    const keyPart = match.slice(0, colon + 1);
    const val = match.slice(colon + 1).trim();
    const keyName = (keyPart.match(/"\s*([^"]+?)\s*"/) || [])[1] || '';
    const tag = keyToTag(keyName) || 'REDACTED';
    const placeholder = hard ? '████' : '[' + tag + ']';
    return keyPart + (val.startsWith('"') ? ' "' + placeholder + '"' : ' ' + placeholder);
  }

  // Soft-level handler for LABELED_FIELD. At soft, we mask ONLY high-
  // sensitivity keys (credentials, financial accounts, government IDs,
  // contact, DOB). Everything else — names, addresses, location, property
  // names, reservation IDs, room numbers — passes through unchanged so the
  // receiving AI still has enough context to reason about the data.
  function labeledReplaceSoft(match) {
    const colon = match.indexOf(':');
    const keyPart = match.slice(0, colon + 1);
    const val = match.slice(colon + 1).trim();
    const keyName = (keyPart.match(/"\s*([^"]+?)\s*"/) || [])[1] || '';
    const norm = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!HIGH_SENSITIVITY_KEYS.has(norm)) return match;
    if (val === 'true' || val === 'false' || val === 'null') return match;
    if (val.startsWith('"') && val.endsWith('"')) {
      const inner = val.slice(1, -1);
      if (inner.length === 0) return match;
      if (inner.length <= 2) return keyPart + ' "' + '*'.repeat(inner.length) + '"';
      return keyPart + ' "' + inner[0] + '*'.repeat(inner.length - 2) + inner[inner.length - 1] + '"';
    }
    // numeric
    const sign = val.startsWith('-') ? '-' : '';
    const body = sign ? val.slice(1) : val;
    if (body.length <= 1) return keyPart + ' ' + sign + '*';
    return keyPart + ' ' + sign + body[0] + '*'.repeat(body.length - 1);
  }

  // Each pattern declares: name, regex, minLevel it activates at,
  // and per-level transforms. Patterns run in declared order; specific
  // patterns must come before general ones (e.g. CC before LONG_NUMBER).
  const PATTERNS = [
    {
      name: 'LABELED_FIELD',
      // JSON/YAML/dict-style "key": value where the key suggests PII.
      // Runs FIRST at medium+ so structured fields get caught even when
      // the value alone wouldn't (e.g. "latitude": 13.05 — bare number,
      // not a coord pair; or a property name without a hotel suffix).
      // At soft this is skipped so specific patterns can format-preserve.
      regex: /"\s*(?:name|firstname|lastname|fullname|surname|email|emailaddress|phone|phonenumber|mobile|mobilenumber|address|streetaddress|propertyaddress|street|city|state|zip|zipcode|postal|postcode|pincode|latitude|longitude|lat|lng|lon|coordinates|coords|location|dob|birthdate|birthday|ssn|passport|cardnumber|creditcard|cardexpiry|expiry|expirydate|cvv|cvc|guestname|customername|tenantname|propertyname|unitname|unitnumber|roomnumber|reservationid|confirmationnumber|bookingid|invoicenumber|orderid|accountnumber|policynumber|gstnumber|pannumber|aadhaar|taxid|licensenumber|platenumber|country|nationality|checkin|checkout|checkindate|checkoutdate|password|passcode|pin|secret|token|apikey|apisecret|accesstoken|refreshtoken|clientsecret|iban|swift|routingnumber)\s*"\s*:\s*(?:"[^"]*"|-?\d+(?:\.\d+)?|true|false|null)/gi,
      minLevel: 'soft',
      soft: (m) => labeledReplaceSoft(m),
      medium: (m) => labeledReplace(m, false),
      hard: (m) => labeledReplace(m, true),
    },
    {
      name: 'CREDIT_CARD',
      // Loose match for 13–19 digits with optional spaces/hyphens.
      regex: /\b(?:\d[ -]?){12,18}\d\b/g,
      minLevel: 'soft',
      soft: (m) => {
        const digits = m.replace(/\D/g, '');
        if (digits.length < 13 || digits.length > 19) return m;
        const last4 = digits.slice(-4);
        const masked = '*'.repeat(digits.length - 4);
        return (masked + last4).replace(/(.{4})/g, '$1 ').trim();
      },
      medium: () => '[CREDIT_CARD]',
      hard: () => '████████████████',
    },
    {
      name: 'SSN',
      regex: /\b\d{3}-\d{2}-\d{4}\b/g,
      minLevel: 'soft',
      soft: (m) => '***-**-' + m.slice(-4),
      medium: () => '[SSN]',
      hard: () => '██████████',
    },
    {
      name: 'PASSPORT',
      // 1–2 leading letters + 6–9 digits — covers India (1 letter + 7),
      // UK/EU (1–2 letters + 6–8), Russia (2 letters + 7), etc.
      // Pure-numeric passports (US: 9 digits) are too ambiguous to detect
      // without context, so we only match the letter-prefixed forms.
      regex: /\b[A-Z]{1,2}\d{6,9}\b/g,
      minLevel: 'soft',
      soft: (m) => {
        if (m.length <= 4) return '*'.repeat(m.length);
        return m.slice(0, 2) + '*'.repeat(m.length - 4) + m.slice(-2);
      },
      medium: () => '[PASSPORT]',
      hard: () => '████████',
    },
    {
      name: 'AADHAAR',
      // India Aadhaar: 12 digits, usually grouped as "XXXX XXXX XXXX"
      // or "XXXX-XXXX-XXXX". Bare 12-digit form also caught.
      regex: /\b\d{4}[\s-]\d{4}[\s-]\d{4}\b|\b\d{12}\b/g,
      minLevel: 'soft',
      soft: (m) => {
        const digits = m.replace(/\D/g, '');
        const last4 = digits.slice(-4);
        const sep = m.includes('-') ? '-' : (m.includes(' ') ? ' ' : '');
        return sep ? 'XXXX' + sep + 'XXXX' + sep + last4 : 'XXXXXXXX' + last4;
      },
      medium: () => '[AADHAAR]',
      hard: () => '████████████',
    },
    {
      name: 'PAN',
      // India PAN — exact shape: 5 letters, 4 digits, 1 letter (AAAAA9999A).
      regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
      minLevel: 'soft',
      soft: (m) => m.slice(0, 2) + '****' + m.slice(-4),
      medium: () => '[PAN]',
      hard: () => '██████████',
    },
    {
      name: 'GST',
      // India GSTIN — 15 chars: 2 digits (state) + PAN-shape + 1 digit + Z + 1 alphanum.
      regex: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[A-Z\d]\b/g,
      minLevel: 'soft',
      soft: (m) => m.slice(0, 2) + '*'.repeat(m.length - 6) + m.slice(-4),
      medium: () => '[GST]',
      hard: () => '███████████████',
    },
    {
      name: 'UK_NIN',
      // UK National Insurance Number: 2 letters + 6 digits + final [A–D].
      regex: /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g,
      minLevel: 'soft',
      soft: (m) => m.slice(0, 2) + ' ** ** ' + m.slice(-2),
      medium: () => '[NIN]',
      hard: () => '█████████',
    },
    {
      name: 'CANADA_SIN',
      // Canadian Social Insurance Number: 999-999-999 or 999 999 999.
      // (Bare 9-digit form is too ambiguous standalone, so we only match the
      // separator-grouped form to keep false positives low.)
      regex: /\b\d{3}[\s-]\d{3}[\s-]\d{3}\b/g,
      minLevel: 'soft',
      soft: (m) => {
        const sep = m.includes('-') ? '-' : ' ';
        return '***' + sep + '***' + sep + m.slice(-3);
      },
      medium: () => '[SIN]',
      hard: () => '███████████',
    },
    {
      name: 'BRAZIL_CPF',
      // Brazilian CPF: 999.999.999-99 (individual taxpayer).
      regex: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
      minLevel: 'soft',
      soft: (m) => '***.***.***-' + m.slice(-2),
      medium: () => '[CPF]',
      hard: () => '██████████████',
    },
    {
      name: 'BRAZIL_CNPJ',
      // Brazilian CNPJ: 99.999.999/9999-99 (corporate taxpayer).
      regex: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g,
      minLevel: 'soft',
      soft: (m) => '**.***.***/****-' + m.slice(-2),
      medium: () => '[CNPJ]',
      hard: () => '██████████████████',
    },
    {
      name: 'ITALY_CF',
      // Italian Codice Fiscale: 16 chars in a fixed pattern.
      regex: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/g,
      minLevel: 'soft',
      soft: (m) => m.slice(0, 3) + '*'.repeat(10) + m.slice(-3),
      medium: () => '[CODICE_FISCALE]',
      hard: () => '████████████████',
    },
    {
      name: 'IBAN',
      // International Bank Account Number: 2 country letters + 2 check digits
      // + 11–30 alphanumerics. Total length 15–34. Covers ~80 countries.
      regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
      minLevel: 'soft',
      soft: (m) => m.slice(0, 4) + '*'.repeat(m.length - 8) + m.slice(-4),
      medium: () => '[IBAN]',
      hard: () => '████████████████████',
    },
    {
      name: 'CHINA_ID',
      // China Resident Identity Card: 17 digits + final digit or X.
      regex: /\b\d{17}[\dXx]\b/g,
      minLevel: 'soft',
      soft: (m) => m.slice(0, 4) + '*'.repeat(10) + m.slice(-4),
      medium: () => '[CHINA_ID]',
      hard: () => '██████████████████',
    },
    {
      name: 'EMAIL',
      regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
      minLevel: 'soft',
      soft: (m) => {
        const [user, domain] = m.split('@');
        const u = user.length <= 2
          ? user[0] + '*'
          : user.slice(0, 2) + '*'.repeat(Math.max(1, user.length - 2));
        return u + '@' + domain;
      },
      medium: () => '[EMAIL]',
      hard: () => '████████',
    },
    {
      name: 'PHONE',
      // US-leaning but tolerant of common international shapes. Accepts:
      //   555-123-4567, 555.123.4567, 555 123 4567
      //   (555) 123-4567, (555)123-4567, (555)1234567
      //   +1 555-123-4567, +44 20 7946 0958, +91-98765-43210
      //   5551234567 (bare 10 digits)
      regex: /\+?\d{1,3}[-.\s]\d{1,4}[-.\s]\d{1,4}[-.\s]\d{2,4}\b|\(\d{3}\)\s?\d{3}[-.\s]?\d{4}\b|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\b\d{10,11}\b/g,
      minLevel: 'soft',
      soft: (m) => {
        const digits = m.replace(/\D/g, '');
        if (digits.length < 7) return m;
        return '***-***-' + digits.slice(-4);
      },
      medium: () => '[PHONE]',
      hard: () => '████████████',
    },
    {
      name: 'IPV4',
      regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
      minLevel: 'soft',
      soft: (m) => {
        const parts = m.split('.');
        return parts[0] + '.' + parts[1] + '.*.*';
      },
      medium: () => '[IP_ADDRESS]',
      hard: () => '███████████',
    },
    {
      name: 'COORDINATES',
      // Decimal pair: "40.7128, -74.0060" (≥2 decimal places to avoid catching version numbers)
      // DMS pair:     40°42'46"N 74°00'21"W
      regex: /-?\d{1,3}\.\d{2,}\s*[,;]\s*-?\d{1,3}\.\d{2,}\b|\d{1,3}°\s?\d{1,2}['′]\s?\d{1,2}(?:\.\d+)?["″]\s?[NSEW][\s,]+\d{1,3}°\s?\d{1,2}['′]\s?\d{1,2}(?:\.\d+)?["″]\s?[NSEW]/g,
      minLevel: 'soft',
      soft: (m) => m.replace(/(-?\d{1,3}\.)\d+/g, '$1**'),
      medium: () => '[COORDINATES]',
      hard: () => '████████████',
    },
    {
      name: 'API_KEY',
      // Common shapes: sk_live_xxx, pk_xxx, ghp_xxx, AIza..., Bearer xxx, AKIA... etc.
      regex: /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|AKIA|ASIA|AIza)[_\-][A-Za-z0-9_\-]{16,}\b|\b(?:Bearer|bearer)\s+[A-Za-z0-9_\-\.]{20,}\b|\b[A-Fa-f0-9]{32,}\b/g,
      minLevel: 'soft',
      soft: (m) => {
        if (m.length <= 12) return '*'.repeat(m.length);
        return m.slice(0, 4) + '*'.repeat(Math.max(4, m.length - 8)) + m.slice(-4);
      },
      medium: () => '[API_KEY]',
      hard: () => '████████████████',
    },
    {
      name: 'URL',
      regex: /https?:\/\/[^\s<>"')]+/g,
      minLevel: 'medium',
      soft: (m) => m,
      medium: (m) => {
        try {
          const u = new URL(m);
          return '[URL:' + u.hostname + ']';
        } catch (_) {
          return '[URL]';
        }
      },
      hard: () => '████████',
    },
    {
      name: 'DATE',
      regex: /\b(?:\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g,
      minLevel: 'medium',
      soft: (m) => m,
      medium: () => '[DATE]',
      hard: () => '██████████',
    },
    {
      name: 'ADDRESS',
      regex: /\b\d{1,5}\s+(?:[A-Z][a-zA-Z]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Parkway|Pkwy|Terrace|Ter|Highway|Hwy|Crescent|Close|Mews|Square|Gardens|Walk|Row|Hill|Park|Quay|Wharf|Marg|Nagar|Colony|Sector)\b\.?/g,
      minLevel: 'medium',
      soft: (m) => m,
      medium: () => '[ADDRESS]',
      hard: () => '██████████',
    },
    {
      name: 'PROPERTY_NAME',
      // Hotel/resort detection — two prongs:
      //   1) Known chain name (Marriott, Hilton, etc.) optionally followed by location words
      //   2) Capitalized words ending in a property suffix (Hotel, Inn, Resort, Suites, …)
      // Runs before NAME so chain+location strings get the PROPERTY label, not NAME.
      regex: /\b(?:Marriott|Hilton|Hyatt|Sheraton|Westin|Wyndham|Radisson|DoubleTree|Hampton|Courtyard|Holiday\s+Inn|Best\s+Western|Comfort\s+Inn|Quality\s+Inn|Days\s+Inn|Crowne\s+Plaza|Embassy\s+Suites|Residence\s+Inn|Fairfield\s+Inn|Four\s+Seasons|Ritz[\s-]?Carlton|St\.?\s+Regis|JW\s+Marriott|Mandarin\s+Oriental|Shangri[\s-]?La|InterContinental|Kimpton|Conrad|Waldorf|Andaz|Park\s+Hyatt|Grand\s+Hyatt|Hyatt\s+Place|Hyatt\s+House|Le\s+M[eé]ridien|W\s+Hotel|Aman|Rosewood|Peninsula|Banyan\s+Tree|Anantara|Six\s+Senses|Capella|COMO|Raffles|Fairmont|Accor|Novotel|Mercure|Ibis|Pullman|Sofitel|MGallery|Renaissance|Aloft|Moxy|Autograph|Tribute|Edition|Hoxton|Citizen\s?M|Indigo|Voco|Even|Holiday\s+Express|Premier\s+Inn|Travelodge|Motel\s+6|Super\s+8|Choice|Sleep\s+Inn|Taj|Oberoi|Leela|ITC|Marina\s+Bay)\b(?:\s+[A-Z][a-zA-Z]+){0,4}|\b(?:The\s+)?(?:[A-Z][a-zA-Z&]+\s+){1,4}(?:Hotel|Hotels|Inn|Resort|Motel|Lodge|Suite|Residence|Plaza|Tower|Villa|Manor|Hostel|Guesthouse|Spa|Apartment|Loft|Pavilion|Retreat|Cottage|Bungalow|Palace|Estate|Chateau|Ryokan|Riad|Hacienda|Auberge)s?\b/g,
      minLevel: 'medium',
      soft: (m) => m,
      medium: () => '[PROPERTY]',
      hard: () => '██████████████',
    },
    {
      name: 'NAME',
      // Heuristic: title + capitalized words, or two-three capitalized words in a row.
      regex: /\b(?:Mr|Ms|Mrs|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b|\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?\b/g,
      minLevel: 'hard',
      soft: (m) => m,
      medium: (m) => m,
      hard: () => '[NAME]',
    },
    {
      name: 'LONG_NUMBER',
      regex: /\b\d{6,}\b/g,
      minLevel: 'hard',
      soft: (m) => m,
      medium: (m) => m,
      hard: () => '[NUMBER]',
    },
  ];

  const LEVEL_RANK = { soft: 1, medium: 2, hard: 3 };

  function redact(text, level) {
    if (typeof text !== 'string' || !text) return { text: '', counts: {} };
    const target = LEVEL_RANK[level] || LEVEL_RANK.medium;
    let out = text;
    const counts = {};
    for (const p of PATTERNS) {
      if (target < LEVEL_RANK[p.minLevel]) continue;
      out = out.replace(p.regex, (m) => {
        counts[p.name] = (counts[p.name] || 0) + 1;
        return p[level](m);
      });
    }
    return { text: out, counts };
  }

  function redactText(text, level) {
    return redact(text, level).text;
  }

  global.BlackBarRedactor = { redact, redactText, PATTERNS, LEVEL_RANK };
})(typeof self !== 'undefined' ? self : globalThis);
