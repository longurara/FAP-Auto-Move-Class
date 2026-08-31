/**
 * NETWORK BRIDGE — runs inside the portal page.
 *
 * This is the whole reason the file exists, and it is not a side note:
 *
 * When the extension page (chrome-extension://…) fetches the portal, that is a
 * CROSS-ORIGIN request carrying an `Origin: chrome-extension://<id>` header,
 * and the portal answers it with a flat 403 — not a challenge page, a refusal.
 * `host_permissions` does not rescue this: permissions are Chrome's side of the
 * deal, while serving the request is decided on the server.
 *
 * A content script, on the other hand, runs INSIDE the portal page, so its
 * fetches are same-origin: no Origin header, the correct Referer, and
 * `Sec-Fetch-Site: same-origin` — the normal shape of a request the page itself
 * would make.
 *
 * Hence the split: the UI lives in the extension tab (long-lived, runs the
 * hours-long hunting loop) and the network goes through here. Each side does
 * only what it alone can do.
 *
 * This file injects NOTHING into the portal page. There used to be a floating
 * button in the corner; it is gone. The toolbar icon already opens the tool,
 * and stacking a foreign button onto the university's page was more nuisance
 * than convenience.
 */

const BASE = 'https://fap.fpt.edu.vn';

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  // Handshake: the other side needs to know the content script IS ALIVE, not
  // merely that the tab is still open. Reloading the extension disconnects the
  // old content script while the tab stays exactly where it was.
  if (msg && msg.type === 'FAP_PING') {
    reply({ ok: true });
    return true;
  }

  /**
   * Student photos: fetched INSIDE the portal page, returned as a data URI.
   *
   * Do not put <img src="https://…"> straight into the extension page: that is
   * a third-party request, Chrome may not send the session cookie with it, and
   * the portal's image endpoint requires the session. The result is a wall of
   * broken images with no error to go on.
   *
   * Fetched here, it is same-origin and the cookie rides along as usual.
   */
  if (msg && msg.type === 'FAP_IMAGE') {
    const url = msg.url.startsWith('http') ? msg.url : BASE + msg.url;
    if (!url.startsWith(BASE + '/')) {
      reply({ ok: false, error: 'URL ngoài FAP bị chặn' });
      return true;
    }

    fetch(url, { credentials: 'include', cache: 'force-cache' })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(blob => new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(new Error('Không đọc được ảnh'));
        fr.readAsDataURL(blob);
      }))
      .then(dataUrl => reply({ ok: true, dataUrl }))
      .catch(e => reply({ ok: false, error: e.message }));

    return true;
  }

  if (!msg || msg.type !== 'FAP_FETCH') return false;

  const url = msg.url.startsWith('http') ? msg.url : BASE + msg.url;

  // Block anything that is not the portal: this bridge forwards requests with
  // the login cookie attached, so letting it call arbitrary hosts would be
  // opening a session-leak channel by hand.
  if (!url.startsWith(BASE + '/')) {
    reply({ ok: false, error: 'URL ngoài FAP bị chặn' });
    return true;
  }

  const init = {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow'
  };
  if (msg.method === 'POST') {
    init.method = 'POST';
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = msg.body;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), msg.timeout || 120000);
  init.signal = ctl.signal;

  fetch(url, init)
    .then(async (r) => {
      const html = await r.text();
      reply({ ok: true, status: r.status, url: r.url, html });
    })
    .catch((e) => {
      reply({ ok: false, error: e.name === 'AbortError' ? 'FAP không trả lời kịp' : e.message });
    })
    .finally(() => clearTimeout(timer));

  // Required: tells Chrome the reply is coming asynchronously
  return true;
});
