/**
 * Service worker: does exactly one thing — open the tool's tab.
 *
 * Do NOT put the slot-hunting loop here. An MV3 service worker is stopped by
 * Chrome after ~30 seconds idle, while a hunt can run for hours. The loop has
 * to live on the extension's own PAGE (app.html) — a page opened in a tab lives
 * exactly as long as the tab does, and can loop for as long as it likes.
 */

const APP = 'app.html';

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL(APP);
  const [found] = await chrome.tabs.query({ url });

  // Already open: switch to it instead of opening a second one. Two tabs
  // hunting the same class means firing two parallel requests at a server
  // that is already congested.
  if (found) {
    await chrome.tabs.update(found.id, { active: true });
    await chrome.windows.update(found.windowId, { focused: true });
    return;
  }

  await chrome.tabs.create({ url });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'OPEN_APP') {
    chrome.tabs.create({ url: chrome.runtime.getURL(APP) });
    reply({ ok: true });
  }
  return true;
});
