// background.js — MV3 service worker.
// Provides a right-click "Redact with BlackBar" submenu on any selected text.

importScripts('redactor.js');

const LEVELS = ['soft', 'medium', 'hard'];
const TITLES = { soft: 'Soft — partial mask', medium: 'Medium — tag labels', hard: 'Hard — obliterate' };

chrome.runtime.onInstalled.addListener(() => {
  // Clear out any stale items from previous installs/dev reloads.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'blackbar-root',
      title: 'Redact with BlackBar',
      contexts: ['selection'],
    });
    LEVELS.forEach((level) => {
      chrome.contextMenus.create({
        id: 'blackbar-' + level,
        parentId: 'blackbar-root',
        title: TITLES[level],
        contexts: ['selection'],
      });
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId || '');
  if (!id.startsWith('blackbar-')) return;
  const level = id.replace('blackbar-', '');
  if (!LEVELS.includes(level)) return;

  const original = info.selectionText || '';
  if (!original) return;
  const result = self.BlackBarRedactor.redact(original, level);
  const redacted = result.text;

  // Service workers can't access navigator.clipboard directly, so inject
  // a tiny copier into the active tab.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (txt, lvl, n) => {
        const write = async () => {
          try {
            await navigator.clipboard.writeText(txt);
          } catch (_) {
            const ta = document.createElement('textarea');
            ta.value = txt;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (e) {}
            ta.remove();
          }
        };
        write();

        // Small unobtrusive toast in the page.
        const t = document.createElement('div');
        t.textContent = 'BlackBar — ' + lvl + ' redact copied (' + n + ' items)';
        Object.assign(t.style, {
          position: 'fixed', bottom: '20px', right: '20px',
          background: '#000000', color: '#ffffff',
          padding: '10px 14px', font: '12px ui-monospace, Menlo, monospace',
          letterSpacing: '0.04em', zIndex: 2147483647,
          border: '1px solid #ffffff',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        });
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2200);
      },
      args: [redacted, level, Object.values(result.counts).reduce((a, b) => a + b, 0)],
    });
  } catch (err) {
    console.warn('BlackBar: could not write to clipboard', err);
  }
});
