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
      minLevel: 'medium',
      soft: (m) => m,
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
      regex: /\b\d{1,5}\s+(?:[A-Z][a-zA-Z]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Parkway|Pkwy|Terrace|Ter|Highway|Hwy|Marg|Road|Nagar|Colony)\b\.?/g,
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
      regex: /\b(?:Marriott|Hilton|Hyatt|Sheraton|Westin|Wyndham|Radisson|DoubleTree|Hampton|Courtyard|Holiday\s+Inn|Best\s+Western|Comfort\s+Inn|Quality\s+Inn|Days\s+Inn|Crowne\s+Plaza|Embassy\s+Suites|Residence\s+Inn|Fairfield\s+Inn|Four\s+Seasons|Ritz[\s-]?Carlton|St\.?\s+Regis|JW\s+Marriott|Mandarin\s+Oriental|Shangri[\s-]?La|InterContinental|Kimpton|Conrad|Waldorf|Andaz|Park\s+Hyatt|Le\s+M[eé]ridien|W\s+Hotel|Aman|Rosewood|Peninsula|Banyan\s+Tree|Taj|Oberoi|Leela|ITC|Marina\s+Bay)\b(?:\s+[A-Z][a-zA-Z]+){0,4}|\b(?:The\s+)?(?:[A-Z][a-zA-Z&]+\s+){1,4}(?:Hotel|Inn|Resort|Motel|Lodge|Suite|Residence|Plaza|Tower|Villa|Manor|Hostel|Guesthouse|Spa|Apartment|Loft|Pavilion|Retreat|Cottage|Bungalow|Palace)s?\b/g,
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
