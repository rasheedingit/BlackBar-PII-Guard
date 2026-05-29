// content.js — paste interceptor for chat inputs and other editable fields.
// When the clipboard text contains detectable sensitive data, shows a small
// inline picker so the user can choose a redaction level before insertion.

(function () {
  'use strict';

  if (window.__blackbarPasteHookInstalled) return;
  window.__blackbarPasteHookInstalled = true;

  const LOG_PREFIX = '[BlackBar]';
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  log('content script loaded on', location.href);

  const LEVELS = ['soft', 'medium', 'hard'];
  let preferredLevel = 'medium';

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['level'], (data) => {
      if (data.level && LEVELS.includes(data.level)) preferredLevel = data.level;
    });
  }

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'url', 'email', 'tel', ''].includes(t) && !el.readOnly && !el.disabled;
    }
    return false;
  }

  function countMatches(text, level) {
    const r = self.BlackBarRedactor.redact(text, level);
    return Object.values(r.counts).reduce((a, b) => a + b, 0);
  }

  function insertIntoTarget(target, text) {
    target.focus();
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      try {
        target.setRangeText(text, start, end, 'end');
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      } catch (_) {
        target.value = target.value.slice(0, start) + text + target.value.slice(end);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }
    // contenteditable — execCommand keeps undo history on most apps (Slack, ChatGPT, etc.)
    try {
      document.execCommand('insertText', false, text);
    } catch (_) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(document.createTextNode(text));
        r.collapse(false);
      }
    }
  }

  let activePicker = null;

  function closePicker() {
    if (!activePicker) return;
    activePicker.host.remove();
    document.removeEventListener('mousedown', activePicker.onOutside, true);
    document.removeEventListener('keydown', activePicker.onKey, true);
    activePicker = null;
  }

  function showPicker(target, originalText) {
    closePicker();

    const counts = {
      soft: countMatches(originalText, 'soft'),
      medium: countMatches(originalText, 'medium'),
      hard: countMatches(originalText, 'hard'),
    };

    const host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      .pop {
        font: 12px ui-monospace, Menlo, monospace;
        background: #000000; color: #ffffff;
        border: 1px solid #ffffff; border-left: 4px solid #ffffff;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        padding: 8px; min-width: 260px; max-width: 460px; user-select: none;
      }
      .hd { display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 6px; opacity: 0.75; letter-spacing: 0.04em; }
      .hd b { color: #ffffff; font-weight: 600; }
      .row { display: grid; grid-template-columns: 1fr auto auto; gap: 4px;
             align-items: center; padding: 4px 6px; cursor: pointer; border-radius: 2px; }
      .row:hover, .row.is-hovered { background: #ffffff; color: #000000; outline: none; }
      .row[data-default="1"]:not(.is-hovered):not(:hover) { background: #222222; }
      .row .lbl { text-transform: lowercase; }
      .row .ct  { opacity: 0.6; font-size: 10px; }
      .row .kb  { opacity: 0.45; font-size: 10px; min-width: 12px; text-align: right; }
      .preview {
        margin-top: 8px; padding: 6px 8px;
        background: #0a0a0a; border: 1px solid #2a2a2a;
        font-size: 10.5px; line-height: 1.4;
        max-height: 220px; overflow-y: auto; overscroll-behavior: contain;
        white-space: pre-wrap; word-break: break-word;
        color: #d0d0d0;
        scrollbar-width: thin; scrollbar-color: #555 #0a0a0a;
      }
      .preview::-webkit-scrollbar { width: 8px; }
      .preview::-webkit-scrollbar-track { background: #0a0a0a; }
      .preview::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
      .preview::-webkit-scrollbar-thumb:hover { background: #666; }
      .preview .lbl { opacity: 0.45; font-size: 9px; text-transform: uppercase;
        letter-spacing: 0.12em; display: block; margin-bottom: 4px;
        position: sticky; top: 0; background: #0a0a0a; padding-bottom: 2px; }
      .ft { opacity: 0.5; font-size: 10px; margin-top: 6px; }
    `;
    shadow.appendChild(style);

    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.innerHTML = `
      <div class="hd"><b>BlackBar</b><span>${originalText.length} chars</span></div>
      <div class="row" data-action="soft"   tabindex="0"><span class="lbl">soft — partial mask</span><span class="ct">${counts.soft}</span><span class="kb">S</span></div>
      <div class="row" data-action="medium" tabindex="0"><span class="lbl">medium — tag labels</span><span class="ct">${counts.medium}</span><span class="kb">M</span></div>
      <div class="row" data-action="hard"   tabindex="0"><span class="lbl">hard — obliterate</span><span class="ct">${counts.hard}</span><span class="kb">H</span></div>
      <div class="row" data-action="asis"   tabindex="0"><span class="lbl">paste as-is</span><span class="ct">·</span><span class="kb">O</span></div>
      <div class="preview"><span class="lbl">preview</span><span class="body"></span></div>
      <div class="ft">enter = ${preferredLevel} · esc = cancel</div>
    `;
    shadow.appendChild(pop);

    const defaultRow = pop.querySelector(`[data-action="${preferredLevel}"]`);
    if (defaultRow) defaultRow.setAttribute('data-default', '1');

    document.body.appendChild(host);

    // Lazy-compute redactions for previews; cache so re-hovering is cheap.
    const previewCache = {};
    function previewFor(action) {
      if (action === 'asis') return originalText;
      if (previewCache[action]) return previewCache[action];
      previewCache[action] = self.BlackBarRedactor.redact(originalText, action).text;
      return previewCache[action];
    }
    const previewBody = pop.querySelector('.preview .body');
    const previewEl = pop.querySelector('.preview');
    function setPreview(action) {
      previewBody.textContent = previewFor(action);
      previewEl.scrollTop = 0;
    }
    setPreview(preferredLevel);

    const rect = target.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let top = rect.bottom + 4, left = rect.left;
    if (top + ph > window.innerHeight - 4) top = Math.max(4, rect.top - ph - 4);
    if (left + pw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - pw - 4);
    host.style.top = top + 'px';
    host.style.left = left + 'px';

    function apply(action) {
      closePicker();
      if (action === 'asis') {
        insertIntoTarget(target, originalText);
      } else if (LEVELS.includes(action)) {
        const out = self.BlackBarRedactor.redact(originalText, action).text;
        insertIntoTarget(target, out);
      }
    }

    pop.querySelectorAll('.row').forEach((row) => {
      row.addEventListener('click', () => apply(row.dataset.action));
      row.addEventListener('mouseenter', () => setPreview(row.dataset.action));
    });
    // When the cursor leaves the row list entirely, fall back to default.
    pop.addEventListener('mouseleave', () => setPreview(preferredLevel));

    const onOutside = (e) => { if (!host.contains(e.target)) closePicker(); };
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if (k === 'escape') { e.preventDefault(); closePicker(); return; }
      if (k === 'enter')  { e.preventDefault(); apply(preferredLevel); return; }
      if (k === 's') { e.preventDefault(); apply('soft'); return; }
      if (k === 'm') { e.preventDefault(); apply('medium'); return; }
      if (k === 'h') { e.preventDefault(); apply('hard'); return; }
      if (k === 'o') { e.preventDefault(); apply('asis'); return; }
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);

    activePicker = { host, onOutside, onKey };
  }

  function onPaste(e) {
    const target = e.target;
    const editable = isEditable(target);
    const cd = e.clipboardData;
    const text = cd ? cd.getData('text/plain') : '';
    const hardCount = text ? countMatches(text, 'hard') : 0;
    log('paste seen', {
      target: target && (target.tagName + (target.id ? '#' + target.id : '')),
      editable,
      chars: text.length,
      hardCount,
    });

    if (!editable) return;
    if (!text || text.length < 4) return;
    if (hardCount === 0) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    showPicker(target, text);
  }

  // Capture phase on both window and document so we beat editors (Lexical,
  // ProseMirror, Quill) that aggressively consume paste on their own root.
  window.addEventListener('paste', onPaste, true);
  document.addEventListener('paste', onPaste, true);
})();
