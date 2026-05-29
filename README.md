# BlackBar — Sensitive Data Redactor

A Chrome extension that anonymizes sensitive data (PII, secrets, identifiers) at three intensity levels. Runs entirely on-device — nothing is sent over the network.

## Install (developer mode)

1. Open `chrome://extensions` in Chrome (or any Chromium browser — Edge, Brave, Arc).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this `blackbar/` folder.
5. Pin the BlackBar icon from the puzzle-piece menu for quick access.

## How to use

**Popup (paste-and-redact):** Click the BlackBar icon, paste text, pick a level, copy the redacted output. Live preview updates as you type.

**Context menu (any page):** Highlight text on any page → right-click → **Redact with BlackBar** → pick a level. The redacted version is copied to your clipboard and a small toast confirms.

## The three levels

| Level | What it does | Example |
| --- | --- | --- |
| **Soft** | Preserves shape, masks middle characters. Good for screenshots where you still want context. | `j***@example.com`, `***-***-1234`, `**** **** **** 1234` |
| **Medium** | Replaces detected items with type labels. Good for sharing logs or tickets. | `[EMAIL]`, `[PHONE]`, `[CREDIT_CARD]`, `[URL:example.com]` |
| **Hard** | Solid black bars + aggressive name/address/long-number detection. Good for screenshots you do not control downstream. | `████████`, plus `[NAME]`, `[ADDRESS]`, `[NUMBER]` |

## What it detects

**Financial:** credit cards, IBAN (~80 countries), API keys (Stripe, GitHub, AWS, Google, bearer tokens, hex secrets).

**National IDs:** US SSN, UK National Insurance Number, Canadian SIN, Brazilian CPF/CNPJ, Italian Codice Fiscale, China Resident ID, India Aadhaar/PAN/GST, generic passport numbers (1–2 letters + 6–9 digits — covers India, UK, EU, Russia, etc.).

**Contact / location:** emails, phone numbers (US + common international shapes), IPv4 addresses, geographic coordinates (decimal-degree pairs or DMS), street addresses (US + UK/AU/India suffixes).

**Structured data:** any JSON/dict-style `"key": value` pair where the key is in a curated PII list (name, email, phone, address, latitude, cardNumber, passport, password, token, etc.) — the value is masked even if it doesn't match a more specific pattern.

**Other:** URLs (medium+), dates (medium+), hotel/resort property names (global chains + suffix heuristic), proper names (hard, heuristic), long numeric IDs (hard).

Patterns live in `redactor.js` — add or tune them there. Each pattern is a `{ name, regex, minLevel, soft, medium, hard }` object.

## Files

```
blackbar/
├── manifest.json     MV3 manifest
├── popup.html        Popup UI
├── popup.css         Popup styling
├── popup.js          Popup controller
├── redactor.js       Pure redaction engine (no DOM deps)
├── background.js     Service worker — context menu
├── icons/            16/48/128 px PNG icons
└── README.md
```

## Privacy

All redaction runs locally in your browser. No network requests, no analytics, no remote scripts. The only storage used is `chrome.storage.local` for your last-used level and last input (so the popup remembers what you were doing). Clear it any time from the extension's storage in `chrome://extensions`.

## Heuristic limits

Pattern-based detection will miss things (creative formatting, unusual locales) and occasionally over-match (capitalized brand names get caught by the name heuristic on Hard). Treat Hard as a strong default, but skim the output before sharing.

## Renaming / forking

The name `BlackBar` is just a working title — change `manifest.json` and the `<h1>` in `popup.html` to whatever you want. The icon source is reproducible from a small PIL script if you want to swap the visual.

## Next steps you might want

- A macOS menu-bar app sharing the same `redactor.js` (wrap with Electron or Tauri)
- A "redact this whole page" button (DOM walker — brittle but doable)
- Custom user-defined patterns in the options page
- Locale packs (IBANs, UK NI numbers, Aadhaar, etc.)
