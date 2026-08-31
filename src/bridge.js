/**
 * THE PATH EVERY PORTAL REQUEST TAKES.
 *
 * Never fetch the portal directly from the extension page. A request from
 * chrome-extension:// carries an Origin header and comes back 403 — tried it,
 * and it broke immediately.
 *
 * Instead, a content script sitting in a portal tab makes the call on our
 * behalf: there the request is same-origin, indistinguishable from one the page
 * itself would issue.
 *
 * The cost is that a portal tab must ALWAYS be open. This module handles that:
 * reuse an existing tab, open a background one when there is none, and rebuild
 * it when the tab is closed.
 */

const BASE = 'https://fap.fpt.edu.vn';
const HOME = BASE + '/Student.aspx';

let tabId = null;

/** Is the portal tab still alive and still answering messages? */
async function alive(id) {
  if (id === null) return false;
  try {
    const tab = await chrome.tabs.get(id);
    if (!tab || !tab.url || !tab.url.startsWith(BASE)) return false;
    // The tab existing is not enough — the content script is the part that can
    // make the call. After the extension reloads, the old content script is
    // disconnected while the tab is untouched.
    const pong = await chrome.tabs.sendMessage(id, { type: 'FAP_PING' }).catch(() => null);
    return !!(pong && pong.ok);
  } catch (e) {
    return false;
  }
}

/** Wait for the tab to finish loading, since content scripts only run at document_idle */
function waitLoaded(id, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const tab = await chrome.tabs.get(id);
        if (tab.status === 'complete') return resolve(tab);
      } catch (e) {
        return reject(new Error('Tab FAP đã bị đóng'));
      }
      if (Date.now() - started > timeout) return reject(new Error('Tab FAP tải quá lâu'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

/**
 * Guarantee a usable portal tab.
 *
 * Prefer a tab the user already has open — opening another one is intrusive,
 * and it also costs one more page load against a server that is often
 * congested.
 */
export async function ensureTab(verify = false) {
  // A tab already known to work is TRUSTED, not re-checked.
  //
  // The previous version called alive() before every request: one
  // chrome.tabs.get plus one PING round-trip to the content script. That made
  // every portal request cost THREE IPC round-trips instead of one. Opening one
  // subject fires roughly 20 requests, so 40 wasted round-trips — before the
  // portal itself, which is slow already, has spent a single second.
  //
  // If the tab is dead, sendMessage throws, and send() catches that and rebuilds
  // it. Checking up front makes every request pay for one rare case.
  if (tabId !== null && !verify) return tabId;
  if (await alive(tabId)) return tabId;

  const tabs = await chrome.tabs.query({ url: BASE + '/*' });
  if (tabs.length) {
    tabId = tabs[0].id;
    await waitLoaded(tabId).catch(() => {});
    return tabId;
  }

  // Opened in the background: the user is looking at the tool's UI and should
  // not be yanked over to another tab.
  const tab = await chrome.tabs.create({ url: HOME, active: false });
  tabId = tab.id;
  await waitLoaded(tabId);
  return tabId;
}

async function send(payload) {
  const id = await ensureTab();
  try {
    return await chrome.tabs.sendMessage(id, payload);
  } catch (e) {
    // Tab just closed, or the content script has not attached yet: rebuild
    // exactly ONCE. Retrying forever here would turn a configuration mistake
    // into a silent infinite loop.
    tabId = null;
    const again = await ensureTab(true);
    return await chrome.tabs.sendMessage(again, payload);
  }
}

export async function fapGet(url, timeout) {
  const r = await send({ type: 'FAP_FETCH', url, timeout });
  if (!r) throw new Error('Không nhận được trả lời từ tab FAP');
  if (!r.ok) throw new Error(r.error || 'Lỗi không rõ');
  return r;
}

export async function fapPost(url, body, timeout) {
  const r = await send({ type: 'FAP_FETCH', url, method: 'POST', body, timeout });
  if (!r) throw new Error('Không nhận được trả lời từ tab FAP');
  if (!r.ok) throw new Error(r.error || 'Lỗi không rõ');
  return r;
}

/** Student photo, returned as a data URI (see the notes in content.js) */
export async function fapImage(url) {
  const r = await send({ type: 'FAP_IMAGE', url });
  if (!r || !r.ok) throw new Error((r && r.error) || 'Không tải được ảnh');
  return r.dataUrl;
}
