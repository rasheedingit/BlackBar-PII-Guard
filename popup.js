// popup.js — UI controller for the BlackBar popup.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const input = $('input');
  const output = $('output');
  const status = $('status');
  const levelButtons = document.querySelectorAll('.lvl');

  let currentLevel = 'medium';
  let debounceT;

  // Restore preferences and last input.
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['level', 'lastInput'], (data) => {
      if (data.level) setLevel(data.level, /*persist*/ false);
      if (data.lastInput) {
        input.value = data.lastInput;
        doRedact();
      }
    });
  }

  function setLevel(level, persist = true) {
    if (!['soft', 'medium', 'hard'].includes(level)) return;
    currentLevel = level;
    levelButtons.forEach((b) => {
      const active = b.dataset.level === level;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    if (persist && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ level });
    }
    if (input.value.trim()) doRedact();
  }

  function doRedact() {
    const text = input.value;
    if (!text) {
      output.value = '';
      status.textContent = '';
      return;
    }
    const result = BlackBarRedactor.redact(text, currentLevel);
    output.value = result.text;
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ lastInput: text });
    }
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
    flash(total === 0 ? 'no matches' : total + ' redacted');
  }

  function flash(msg, ms = 1800) {
    status.textContent = msg;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => {
      if (status.textContent === msg) status.textContent = '';
    }, ms);
  }

  // Level switching.
  levelButtons.forEach((b) => {
    b.addEventListener('click', () => setLevel(b.dataset.level));
  });

  // Actions.
  $('redact-btn').addEventListener('click', doRedact);

  $('clear-btn').addEventListener('click', () => {
    input.value = '';
    output.value = '';
    status.textContent = '';
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ lastInput: '' });
    }
    input.focus();
  });

  $('paste-btn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        flash('clipboard empty');
        return;
      }
      input.value = text;
      doRedact();
    } catch (_) {
      flash('clipboard blocked');
    }
  });

  $('copy-btn').addEventListener('click', async () => {
    if (!output.value) {
      flash('nothing to copy');
      return;
    }
    try {
      await navigator.clipboard.writeText(output.value);
      flash('copied');
    } catch (_) {
      output.select();
      try {
        document.execCommand('copy');
        flash('copied');
      } catch (e2) {
        flash('copy failed');
      }
    }
  });

  // Live redaction with debounce.
  input.addEventListener('input', () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(doRedact, 220);
  });

  // Keyboard: Cmd/Ctrl+Enter redacts immediately.
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      doRedact();
    }
  });

  // Auto-focus input on open.
  setTimeout(() => input.focus(), 50);
})();
