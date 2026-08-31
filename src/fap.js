import {
  parseEnrolledCourses, parseMoveOptions, parseNewSlot, parseOldGroup,
  parseCourseList, parseAttendanceDetail, parseCampusKey, parseDepartments,
  parseClassCounts, parseSubjectCodes, parseRoster, hiddenFields, isLoggedIn,
  parseSubjectLabel
} from './parse.js';

/**
 * THE PORTAL CALL LAYER.
 *
 * No puppeteer, no CDP, no separate Chrome. The user signs in to the portal in
 * their own browser and the tool reuses that session.
 *
 * BUT having host_permissions does not mean fetch works. That was the initial
 * assumption and it was wrong on the very first request: a fetch from the
 * extension page to the portal is CROSS-ORIGIN, carries
 * Origin: chrome-extension://…, and comes back as a flat 403. host_permissions
 * only settles the Chrome side; whether the request is served is decided on the
 * server.
 *
 * So every request goes through bridge.js -> the content script in a portal tab,
 * where the request is same-origin. See the notes in content.js.
 *
 * Still dropped compared with the CLI build: automatic SSO login, DPAPI password
 * storage, session keep-alive, hiding the window. Those four existed only
 * because the CLI drives a browser from the outside.
 */

import { fapGet, fapPost, fapImage } from './bridge.js';

const BASE = 'https://fap.fpt.edu.vn';

/** How long before the portal counts as no longer answering */
const TIMEOUT = 120000;

export class FapError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'FapError';
    this.kind = kind;
  }
}

/**
 * Recognise the portal's error pages when it is overloaded.
 *
 * At peak times the server returns all sorts: 503 "The service is unavailable",
 * an edge-layer refusal page, 500. Telling them apart is what decides whether to
 * keep waiting or stop — giving up on the first error means giving up exactly
 * when demand is highest.
 */
function detectErrorPage(status, html) {
  // A 403 from the edge layer means REFUSED, which is nothing like a page still
  // waiting on verification. Treating the two as one leaves the user waiting on
  // something that will never clear by itself — the exact mistake made by
  // letting the extension page fetch on its own.
  if (status === 403 && /cloudflare|cf-ray|Attention Required/i.test(html)) {
    return new FapError('Cloudflare chặn request (403) — request không đi qua tab FAP', 'BLOCKED');
  }
  if (/Just a moment|cf-browser-verification|challenge-platform/i.test(html)) {
    return new FapError('Cloudflare đang kiểm tra trình duyệt', 'CHALLENGE');
  }
  if (/The service is unavailable/i.test(html) || status === 503) {
    return new FapError('Máy chủ quá tải (503)', 'BUSY');
  }
  if (status === 500 || /Server Error in/i.test(html)) {
    return new FapError('Máy chủ lỗi (500)', 'SERVER');
  }
  if (status === 0) return new FapError('Không kết nối được', 'NETWORK');
  if (status >= 400) return new FapError(`HTTP ${status}`, 'HTTP');
  return null;
}

/**
 * Every request goes through the content script in a portal tab.
 *
 * Do NOT call fetch() directly here. A fetch from the extension page to the
 * portal is cross-origin, carries Origin: chrome-extension://…, and comes back
 * 403 — tried it, and it broke on the very first request.
 */
/**
 * Which errors are worth retrying, and which are not.
 *
 * Getting this right is what makes the handling correct: an overloaded server
 * means wait and try again — giving up exactly when demand peaks makes the tool
 * useless. A lost session or a wrong URL, on the other hand, will fail the same
 * way however many times you retry, just slower and at the expense of a server
 * that is already struggling.
 */
const RETRYABLE = new Set(['BUSY', 'SERVER', 'TIMEOUT', 'NETWORK', 'CHALLENGE']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Reporting and cancellation for the retry logic.
 *
 * With UNBOUNDED retries, these two are mandatory, not optional:
 *
 *   - it must SAY what it is waiting on and which attempt this is. Otherwise the
 *     user stares at a frozen screen with no way to tell "patiently waiting on
 *     the portal" apart from "the tool has hung".
 *   - it must be STOPPABLE. A configuration mistake meeting an unbounded loop
 *     spins forever, burning requests against a struggling server, unnoticed.
 */
let onRetryGlobal = null;
let cancelled = false;

export function setRetryReporter(fn) { onRetryGlobal = fn; }
export function cancelAll() { cancelled = true; }
export function resetCancel() { cancelled = false; }
export function isCancelled() { return cancelled; }

/**
 * Call the portal with backed-off retries.
 *
 * The backoff grows (1.5s → 3s → 6s → 12s, capped at 20s): the portal is
 * congested because too many students are clicking at once, so hammering it with
 * rapid retries only makes it worse.
 */
async function req(url, { method, body, timeout, retries = Infinity, onRetry } = {}) {
  let wait = 1500;

  for (let attempt = 0; ; attempt++) {
    if (cancelled) throw new FapError('Đã huỷ', 'CANCELLED');

    try {
      const r = method === 'POST'
        ? await fapPost(url, body, timeout || TIMEOUT)
        : await fapGet(url, timeout || TIMEOUT);

      const bad = detectErrorPage(r.status, r.html);
      if (bad) throw bad;

      // Just got through after a wait -> report it so the UI clears the warning
      if (attempt > 0 && onRetryGlobal) onRetryGlobal(null, 0, 0);
      return { html: r.html, url: r.url, status: r.status };
    } catch (e) {
      const err = e instanceof FapError ? e : new FapError(e.message || 'Lỗi mạng', 'NETWORK');

      // Anything not transient fails outright. Retrying a lost session or a bad
      // URL forever means spinning with no exit, while burning requests against
      // an already-struggling server.
      if (err.kind === 'CANCELLED' || !RETRYABLE.has(err.kind)) throw err;
      if (attempt >= retries) throw err;

      if (onRetry) onRetry(err, attempt + 1, wait);
      if (onRetryGlobal) onRetryGlobal(err, attempt + 1, wait);

      // Sleep in slices so Cancel stops immediately instead of waiting out 20s
      const until = Date.now() + wait;
      while (Date.now() < until) {
        if (cancelled) throw new FapError('Đã huỷ', 'CANCELLED');
        await sleep(Math.min(250, until - Date.now()));
      }

      // Back off, then cap at 20s: the portal is congested because too many
      // people are clicking at once, and rapid retries only add to it. But do
      // not back off too far either — the moment the server recovers, a 5-minute
      // wait costs you the slot.
      wait = Math.min(wait * 2, 20000);
    }
  }
}

export async function get(path, timeout, opts = {}) {
  return await req(path, { timeout, ...opts });
}

/**
 * POST an ASP.NET form: keep every hidden input, then override what changes.
 *
 * `base` accepts EITHER an HTML string or an already-extracted object of hidden
 * fields.
 *
 * Why the second path exists: a portal page weighs a few hundred KB because of
 * __VIEWSTATE, and scanning schedules means one POST per class. Passing the HTML
 * string rebuilds the entire DOM of the same page on every POST — 10 classes is
 * 10 redundant parses, enough to stall the UI for several frames.
 */
export async function postForm(url, base, override, timeout, opts = {}) {
  const fields = typeof base === 'string' ? hiddenFields(base) : base;
  const body = new URLSearchParams({ ...fields, ...override });
  return await req(url, { method: 'POST', body: body.toString(), timeout, ...opts });
}

/* ── Login session ────────────────────────────────────────────── */

export async function checkLogin() {
  const { html } = await get('/Student.aspx');
  return isLoggedIn(html);
}

/* ── Enrolled subjects ────────────────────────────────────────── */

export async function getEnrolledCourses() {
  const { html } = await get('/FrontOffice/Courses.aspx');
  return parseEnrolledCourses(html);
}

/* ── Open classes of a subject ────────────────────────────────── */

/**
 * Open the move-class page for a subject.
 *
 * There is NO URL you can GET directly. The "Move" button on Courses.aspx is an
 * ASP.NET LinkButton: clicking it POSTs back to Courses.aspx itself with an
 * __EVENTTARGET, and only then does the server redirect to
 * MoveSubject.aspx?id=<current class id>.
 *
 * The first version looked for a[href*="MoveSubject.aspx"] in the HTML — it is
 * never there, because that page does not exist until the POST happens.
 *
 * @param {{subjectCode: string, postbackTarget: string}} course
 */
export async function openMoveSubject(course) {
  const base = await get('/FrontOffice/Courses.aspx');

  // Re-read the target from the HTML JUST LOADED, never reuse the previous one:
  // the __VIEWSTATE that goes with it must come from the same load, and the row
  // order may have changed.
  const hit = parseEnrolledCourses(base.html)
    .find(x => x.subjectCode.toUpperCase() === String(course.subjectCode).toUpperCase());

  const target = hit ? hit.postbackTarget : course.postbackTarget;
  const arg = hit ? hit.postbackArg : (course.postbackArg || '');

  if (!target) {
    throw new FapError(`Không thấy nút chuyển lớp cho môn ${course.subjectCode}`, 'NOTFOUND');
  }

  const page = await postForm('/FrontOffice/Courses.aspx', base.html, {
    __EVENTTARGET: target,
    __EVENTARGUMENT: arg
  });

  // CROSS-CHECK the subject returned against the subject requested.
  //
  // Without this step, the portal can return a different subject's page and the
  // tool renders it as if nothing were wrong, with a heading naming the subject
  // the user clicked — because the heading comes from the REQUEST, not the
  // RESPONSE. That bug actually happened: clicking WDU203c showed the 29 classes
  // of SSG105. This kind of wrongness is more dangerous than an error, because
  // it leads to hunting a class belonging to another subject.
  const label = parseSubjectLabel(page.html);
  const want = String(course.subjectCode || '').toUpperCase();

  if (label && want && !label.toUpperCase().includes(want)) {
    const err = new FapError(
      `FAP mở nhầm môn: yêu cầu ${course.subjectCode} nhưng trang trả về "${label}"`,
      'WRONG_SUBJECT'
    );
    err.detail = { target, landedUrl: page.url, label };
    throw err;
  }

  const options = parseMoveOptions(page.html);
  if (!options.length) {
    throw new FapError('Trang chuyển lớp không có danh sách lớp mở', 'EMPTY');
  }

  return {
    url: page.url,
    html: page.html,
    subjectLabel: label,
    groupId: (page.url.match(/[?&]id=(\d+)/i) || [])[1] || '',
    currentClass: parseOldGroup(page.html),
    options
  };
}

/**
 * Schedules of every open class: one dropdown-changing POST per class.
 *
 * Runs in batches of 5 so it does not slam dozens of requests at once into a
 * congested server — the very server the tool wants to answer quickly.
 */
export async function fetchAllSchedules(page, { onProgress = () => {}, onClass = () => {} } = {}) {
  const sel = new DOMParser()
    .parseFromString(page.html, 'text/html')
    .querySelector('#ctl00_mainContent_dllCourse, select[name*="dllCourse"]');
  if (!sel) return [];

  const name = sel.getAttribute('name');
  const opts = page.options;
  const out = [];
  const SIZE = 5;
  let done = 0;

  // Extract once, reuse for every POST
  const fields = hiddenFields(page.html);

  for (let i = 0; i < opts.length; i += SIZE) {
    const batch = opts.slice(i, i + SIZE);

    // Fire onClass AS SOON AS each class finishes, without waiting for the
    // batch. On a congested server one slow class holds up all 5 — the user
    // stares at an empty screen while the other 4 have had data for a while.
    const results = await Promise.all(
      batch.map(async (o) => {
        let row;
        try {
          const r = await postForm(page.url, fields, {
            __EVENTTARGET: 'ctl00$mainContent$dllCourse',
            __EVENTARGUMENT: '',
            [name]: o.value
          }, 60000);
          row = { ...o, schedule: parseNewSlot(r.html) || 'N/A' };
        } catch (e) {
          row = { ...o, schedule: 'N/A', error: e.message };
        }
        done++;
        onProgress(`Đọc lịch ${done}/${opts.length} lớp`, done, opts.length);
        onClass(row);
        return row;
      })
    );
    out.push(...results);
  }

  return out;
}

/* ── Real schedules of the ENROLLED classes (attendance page) ─── */

export async function fetchCurrentSchedules(onProgress = () => {}) {
  const first = await get('/Report/ViewAttendstudent.aspx');
  const list = parseCourseList(first.html);
  const subjects = [];
  const slotTimes = {};

  const selected = list.courses.find(x => x.selected);
  if (selected) {
    const d = parseAttendanceDetail(first.html);
    Object.assign(slotTimes, d.slotTimes);
    subjects.push({ ...selected, pattern: d.pattern, className: selected.className || d.className });
  }

  const linked = list.courses.filter(x => x.courseId);
  for (let i = 0; i < linked.length; i++) {
    const cse = linked[i];
    onProgress(`Đang đọc lịch ${cse.subjectCode || cse.className}… (${i + 1}/${linked.length})`);

    const url = `/Report/ViewAttendstudent.aspx?id=${encodeURIComponent(list.roll)}` +
      `&campus=${list.campus}&term=${list.term}&course=${cse.courseId}`;

    try {
      const r = await get(url);
      const d = parseAttendanceDetail(r.html);
      Object.assign(slotTimes, d.slotTimes);
      subjects.push({ ...cse, pattern: d.pattern, className: cse.className || d.className });
    } catch (e) {
      subjects.push({ ...cse, pattern: [], error: e.message });
    }
  }

  return { ...list, subjects, slotTimes };
}

/* ── Headcounts ───────────────────────────────────────────────── */

/**
 * Collect headcounts from EVERY department containing the subject, not just the
 * first one.
 *
 * Soft-skill subjects (SSG105) name their classes after the MAJOR — SE2040,
 * AI2003, MC2006 — so their classes are spread across many departments.
 * Stopping at the first department yields only the few classes in your own
 * major, leaving the rest blank; and a blank leaves the user unable to tell
 * "class is full" from "the tool could not read it".
 *
 * Headcounts are NOT cached: they change by the minute, and they are the number
 * the decision rests on.
 */
export async function fetchClassSizes(subjectCode, { deptHints = [], wanted = [], onProgress = () => {}, onFound = () => {} } = {}) {
  const root = await get('/Course/Courses.aspx');
  const { key: campusKey, name: campusName } = parseCampusKey(root.html);
  const { campus, term, depts } = parseDepartments(root.html);

  if (!campus || !term) {
    return { classes: [], depts: [], error: 'Không đọc được campus/term từ danh sách khoa' };
  }

  const map = await loadDeptMap();
  const order = [];
  const push = (d) => { if (d && !order.includes(String(d))) order.push(String(d)); };

  deptHints.forEach(push);
  if (map && map.term === term) {
    for (const d of map.departments || []) {
      if ((d.subjects || []).includes(subjectCode.toLowerCase())) push(d.dept);
    }
  }
  depts.forEach(d => push(d.dept));

  const want = new Set(wanted.map(x => String(x).toUpperCase()));
  const found = new Map();
  const used = [];

  for (let i = 0; i < order.length; i++) {
    onProgress(`Đang đọc sĩ số — khoa ${i + 1}/${order.length}…`);
    try {
      const r = await get(`/Course/Courses.aspx?campus=${campus}&term=${term}&dept=${order[i]}`);
      const rows = parseClassCounts(r.html, subjectCode);
      if (!rows.length) continue;

      used.push(order[i]);
      const fresh = [];
      for (const x of rows) {
        const k = x.className.toUpperCase();
        if (!found.has(k)) { found.set(k, x); fresh.push(x); }
      }
      // Emit per batch: one department's headcounts are already usable for that
      // department's classes, so there is no reason to make the user wait until
      // every department has been scanned.
      if (fresh.length) onFound(fresh);

      if (want.size && [...want].every(n => found.has(n))) break;
    } catch (e) {
      // One department failing is skipped; the others may still have data
    }
  }

  return {
    classes: [...found.values()],
    depts: used,
    campus, term, campusKey, campusName,
    error: found.size ? '' : `Không thấy môn ${subjectCode} trong ${order.length} khoa đã dò`
  };
}

/** Build the "subject code -> department" table; runs once, lasts the term */
export async function buildDeptMap(onProgress = () => {}) {
  const root = await get('/Course/Courses.aspx');
  const { key: campusKey, name: campusName } = parseCampusKey(root.html);
  const { campus, term, depts } = parseDepartments(root.html);
  if (!campus || !term || !depts.length) throw new FapError('Không đọc được danh sách khoa', 'PARSE');

  const departments = [];
  const subjects = {};

  for (let i = 0; i < depts.length; i++) {
    onProgress(`Đang đọc khoa ${depts[i].label || depts[i].dept}… (${i + 1}/${depts.length})`);
    try {
      const r = await get(`/Course/Courses.aspx?campus=${campus}&term=${term}&dept=${depts[i].dept}`);
      const codes = parseSubjectCodes(r.html);
      departments.push({ ...depts[i], subjects: codes });
      for (const cde of codes) if (subjects[cde] === undefined) subjects[cde] = depts[i].dept;
    } catch (e) {
      departments.push({ ...depts[i], subjects: [], error: e.message });
    }
  }

  const data = { builtAt: Date.now(), campus, term, campusKey, campusName, departments, subjects };
  await chrome.storage.local.set({ deptMap: data });
  return data;
}

async function loadDeptMap() {
  const { deptMap } = await chrome.storage.local.get('deptMap');
  return deptMap || null;
}

/* ── Class roster ─────────────────────────────────────────────── */

/**
 * The roster of a class.
 *
 * The portal only allows viewing the roster of a class YOU ARE ENROLLED IN.
 * That is also why this function only takes a groupId read from the
 * MoveSubject.aspx?id= URL — that is the current class. It deliberately does not
 * accept an arbitrary id: enumerating numbers in the URL would pull rosters of
 * classes you are not in, which is bulk collection of strangers' personal data.
 */
export async function getRoster(groupId) {
  const { html } = await get(`/Course/Groups.aspx?group=${groupId}`);
  return parseRoster(html);
}

/**
 * Load each student's photo, calling back after every one.
 *
 * Capped at 4 concurrent requests: firing 35 requests at once for a 35-person
 * class at a congested server only slows you down, quite apart from looking like
 * an attack.
 */
export async function fetchPhotos(members, onPhoto = () => {}) {
  const queue = members.filter(m => m.photo);
  let i = 0;

  const worker = async () => {
    while (i < queue.length) {
      const m = queue[i++];
      try {
        onPhoto(m.roll, await fapImage(m.photo));
      } catch (e) {
        onPhoto(m.roll, null);
      }
    }
  };

  await Promise.all([worker(), worker(), worker(), worker()]);
}

/* ── Slot hunting ─────────────────────────────────────────────── */

/**
 * One press of "Save" to move class.
 *
 * Returns a classified status instead of throwing a generic error: "class is
 * full" is the normal case that should be retried, while "session expired" will
 * not improve however many times you retry — the two must be handled
 * differently.
 */
export async function trySave(page, targetValue) {
  const sel = new DOMParser()
    .parseFromString(page.html, 'text/html')
    .querySelector('#ctl00_mainContent_dllCourse, select[name*="dllCourse"]');
  const name = sel ? sel.getAttribute('name') : 'ctl00$mainContent$dllCourse';

  const btn = new DOMParser()
    .parseFromString(page.html, 'text/html')
    .querySelector('input[type="submit"][name*="btnSave"], input[type="submit"][value*="Save" i]');

  const override = { [name]: targetValue };
  if (btn) override[btn.getAttribute('name')] = btn.getAttribute('value') || 'Save';

  const r = await postForm(page.url, page.html, override, 90000);
  const html = r.html;

  if (!isLoggedIn(html)) return { ok: false, kind: 'SESSION', message: 'Phiên đăng nhập đã hết' };
  if (/success|thành công|đã chuyển/i.test(html)) return { ok: true, kind: 'OK', message: 'Đã chuyển lớp' };
  if (/full|đã đầy|not enough|maximum/i.test(html)) return { ok: false, kind: 'FULL', message: 'Lớp đã đầy' };
  if (/conflict|trùng/i.test(html)) return { ok: false, kind: 'CONFLICT', message: 'Trùng lịch' };

  return { ok: false, kind: 'UNKNOWN', message: 'Chưa chuyển được', html };
}
