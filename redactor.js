// redactor.js — core redaction engine, no DOM dependencies.
// Shared between popup.js and background.js (service worker).

(function (global) {
  'use strict';

  // Each pattern declares: name, regex, minLevel it activates at,
  // and per-level transforms. Patterns run in declared order; specific
  // patterns must come before general ones (e.g. CC before LONG_NUMBER).
  const PATTERNS = [
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
      // US-leaning but tolerant of common international shapes.
      regex: /(?:\+?\d{1,3}[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/g,
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
      regex: /\b\d{1,5}\s+(?:[A-Z][a-zA-Z]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Parkway|Pkwy|Terrace|Ter|Highway|Hwy)\b\.?/g,
      minLevel: 'hard',
      soft: (m) => m,
      medium: (m) => m,
      hard: () => '[ADDRESS]',
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
    if (typeof text !== 'string' || !text) return '';
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
