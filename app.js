import * as fap from './src/fap.js';
import * as store from './src/store.js';
import { WEEKDAYS, parseSessions, learnSlotTimes, slotTimeLabel } from './src/parse.js';
import {
  buildBusyMap, evaluateCandidates, rankCandidates, describeReason, summarizeAdvice
} from './src/advisor.js';

/**
 * THE TOOL'S UI.
 *
 * Runs in an extension TAB, not a popup and not a service worker. The reason is
 * the slot-hunting loop:
 *   - a popup dies the moment the user clicks elsewhere
 *   - an MV3 service worker is stopped by Chrome after ~30 seconds idle
 *   - a tab lives exactly as long as the tab does, hours included
 *
 * THE LOADING ORDER is the most important thing here:
 *
 *   1. open the move-class page  -> every open class name is known at once,
 *                                   so the table skeleton can be drawn
 *   2. per-class schedules + headcounts -> run in parallel, filling rows in
 *   3. the attendance page       -> LAST, because it costs one request per
 *                                   subject
 *
 * Step 3 gives two things: the schedule of the enrolled class (always needed)
 * and the busy-hours map (only needed when clash detection is on). It is the
 * slowest, so it goes last — the user has had a complete table to look at long
 * before it finishes.
 */

const $ = (s) => document.querySelector(s);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function svg(paths, size = 14) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  }
  return s;
}

const state = {
  courses: [],
  subject: null,
  page: null,
  rows: new Map(),
  current: null,
  currentName: '',
  busy: new Map(),
  busyKnown: false,
  advice: false,
  view: 'grid',
  sizeAt: 0,
  sizeFresh: false,
  schedFromCache: false,
  schedAt: 0,
  hunting: false
};

const say = (m) => { $('#status').textContent = m || ''; };
const bar = (done, total) => {
  $('#bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
};

function showPane(id) {
  for (const p of document.querySelectorAll('.pane')) p.classList.add('hidden');
  $(id).classList.remove('hidden');
}

/* Throttled repaint: data arrives in bursts, and drawing once per row stutters */
let pending = false;
function scheduleRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; renderClasses(); });
}

/* ── Boot ─────────────────────────────────────────────────────── */

async function boot(force = false) {
  try {
    const st = await store.get('settings');
    state.advice = !!(st && st.data && st.data.advice);
    renderAdviceToggle();

    say('Đang kiểm tra phiên đăng nhập…');
    const ok = await fap.checkLogin();
    $('#session').textContent = ok ? 'đã đăng nhập FAP' : 'chưa đăng nhập';
    $('#session').className = 'chip ' + (ok ? 'ok' : 'bad');

    if (!ok) {
      showPane('#pane-login');
      say('');
      return;
    }

    showPane('#pane-empty');

    say('Đang đọc danh sách môn…');
    const c = await store.cached('courses', store.TTL.courses, fap.getEnrolledCourses, { force });
    state.courses = c.data;
    renderSubjects();
    say(c.fromCache ? 'Danh sách môn từ bản lưu' : '');
  } catch (e) {
    $('#session').textContent = e.message;
    $('#session').className = 'chip bad';
    say(e.message);
  }
}

/**
 * Wait for the user to sign in on the portal tab, then carry on by itself.
 *
 * Do NOT embed the portal in an iframe. Two reasons, and the first is the real
 * one:
 *
 *   1. Putting the university's login form inside the tool's own UI removes the
 *      address bar and the padlock — the user loses every means of verifying
 *      where they are typing their password. That is exactly the shape of a
 *      password-phishing page, and training students to accept it clears the way
 *      for someone else to imitate it.
 *
 *   2. The portal sends `x-frame-options: SAMEORIGIN`, so the browser blocks it
 *      outright. MV3 could strip that header with declarativeNetRequest, but the
 *      login flow also runs a bot check that refuses to run inside a frame.
 *
 * Instead: open a real tab, then ASK the portal every 2 seconds whether the user
 * is signed in. They type their password on the university's actual page, and
 * the tool works out for itself when that is done.
 */
let loginTimer = null;

async function waitForLogin() {
  if (loginTimer) return;
  const label = $('#login-wait');
  label.className = 'waiting';
  label.textContent = 'Đang chờ bạn đăng nhập…';

  const tick = async () => {
    try {
      if (await fap.checkLogin()) {
        stopWaitingLogin();
        $('#session').textContent = 'đã đăng nhập FAP';
        $('#session').className = 'chip ok';
        showPane('#pane-empty');
        say('Đăng nhập xong — đang đọc danh sách môn…');

        const c = await store.cached('courses', store.TTL.courses, fap.getEnrolledCourses);
        state.courses = c.data;
        renderSubjects();
        say('');
        return;
      }
    } catch (e) {
      // While signed out the portal returns all sorts of errors — keep asking,
      // do not stop
    }
    loginTimer = setTimeout(tick, 2000);
  };

  loginTimer = setTimeout(tick, 1500);
}

function stopWaitingLogin() {
  if (loginTimer) clearTimeout(loginTimer);
  loginTimer = null;
  const label = $('#login-wait');
  label.className = 'faint';
  label.textContent = '';
}

function renderSubjects() {
  const box = $('#subjects');
  box.textContent = '';

  if (!state.courses.length) {
    box.appendChild(el('div', 'rail-note', 'Không đọc được môn nào từ bảng gvCourses.'));
    return;
  }

  for (const cse of state.courses) {
    const on = state.subject && state.subject.subjectCode === cse.subjectCode;
    const b = el('button', 'subject' + (on ? ' on' : ''));

    const left = el('div');
    left.style.minWidth = '0';
    left.appendChild(el('div', 'code', cse.subjectCode));
    left.appendChild(el('div', 'cls', cse.currentClass || '—'));
    b.appendChild(left);
    if (cse.slot) b.appendChild(el('div', 'slot', cse.slot));

    b.addEventListener('click', () => openSubject(cse));
    box.appendChild(b);
  }
}

/* ── Opening a subject ────────────────────────────────────────── */

async function openSubject(course, force = false) {
  state.subject = course;
  state.rows = new Map();
  state.current = null;
  state.currentName = '';
  state.busy = new Map();
  state.busyKnown = false;
  state.sizeAt = 0;
  state.schedAt = 0;

  renderSubjects();
  showPane('#pane-classes');
  $('#subject-name').textContent = course.subjectCode;
  $('#open-count').textContent = '';
  $('#classes').textContent = '';
  $('#advice').classList.add('hidden');

  try {
    // 1. A single request already yields every open class name — draw the
    //    skeleton right away so the user sees a shape instead of a blank screen
    //    for the whole wait.
    say('Đang mở trang chuyển lớp…');
    state.page = await fap.openMoveSubject(course);
    state.currentName = state.page.currentClass || course.currentClass || '';

    // The heading comes from the RETURNED PAGE, not from the subject that was
    // clicked: taking it from the request means the UI always asserts exactly
    // what you expected, even when the data underneath belongs to a different
    // subject.
    $('#subject-name').textContent = state.page.subjectLabel || course.subjectCode;
    $('#open-count').textContent = `${state.page.options.length} lớp mở`;

    for (const o of state.page.options) {
      state.rows.set(o.className, { ...o, schedule: null, count: undefined, clashes: [] });
    }
    renderClasses();

    // 2. Per-class schedules and headcounts: independent, so run in parallel
    await Promise.all([loadSchedules(course, force), loadSizes(course)]);

    // 3. The attendance page goes LAST: one sequential request per subject, and
    //    all it adds is the enrolled class (+ clash detection when enabled). The
    //    table has been usable well before this point.
    await loadCurrentSchedules(course);

    say(`Xong · ${state.rows.size} lớp`);
    bar(1, 1);
  } catch (e) {
    $('#classes').textContent = '';
    $('#classes').appendChild(el('div', 'rail-note', 'Lỗi: ' + e.message));

    // When the wrong subject opens, print the details: another round of guessing
    // costs the user a whole run, while these few lines say plainly what
    // happened.
    if (e.detail) {
      const d = el('div', 'rail-note');
      d.appendChild(el('div', null, `đã gửi __EVENTTARGET: ${e.detail.target}`));
      d.appendChild(el('div', null, `trang trả về: ${e.detail.landedUrl}`));
      d.appendChild(el('div', null, `nhãn môn trên trang: ${e.detail.label}`));
      $('#classes').appendChild(d);
    }
    say(e.message);
  }
}

/**
 * The attendance page — source of the enrolled class AND of the busy-hours map.
 *
 * The two are kept separate: the enrolled class is ALWAYS fetched (it is the
 * baseline for comparison, and it comes from the same read anyway), while clash
 * detection is what the advice toggle turns on and off. The previous version
 * dropped both when advice was off, losing the ★ marker on the grid as well.
 */
async function loadCurrentSchedules(course) {
  try {
    say('Đang đọc lịch các môn đang học…');
    const hit = await store.cached(
      'att',
      store.TTL.att,
      () => fap.fetchCurrentSchedules((m) => say(m))
    );
    const att = hit.data;

    learnSlotTimes(att.slotTimes);

    const mine = att.subjects.find(
      s => String(s.subjectCode).toUpperCase() === course.subjectCode.toUpperCase()
    );
    if (mine && mine.pattern.length) {
      state.current = { className: mine.className, sessions: mine.pattern, current: true };
      state.currentName = mine.className;
    }

    // Only THIS part obeys the advice toggle
    if (state.advice) {
      state.busy = buildBusyMap(att.subjects, course.subjectCode);
      state.busyKnown = att.subjects.some(s => (s.pattern || []).length);
    } else {
      state.busy = new Map();
      state.busyKnown = false;
    }

    scheduleRender();
  } catch (e) {
    say('Không đọc được lịch các môn: ' + e.message);
  }
}

/** Schedule of each open class — filled into the table as it arrives */
async function loadSchedules(course, force) {
  const cached = force ? null : await loadCache(course.subjectCode, state.page.options);

  if (cached) {
    for (const r of cached.rows) patchRow(r.className, { schedule: r.schedule });
    state.schedFromCache = true;
    state.schedAt = cached.at;
    scheduleRender();
    return;
  }

  const rows = await fap.fetchAllSchedules(state.page, {
    onProgress: (msg, done, total) => { say(msg); bar(done, total); },
    onClass: (row) => { patchRow(row.className, { schedule: row.schedule }); scheduleRender(); }
  });

  state.schedFromCache = false;
  state.schedAt = Date.now();
  await saveCache(course.subjectCode, rows);
}

/** Headcounts — show the stored copy with its age, then overwrite with fresh */
async function loadSizes(course) {
  const { deptBySubject = {} } = await chrome.storage.local.get('deptBySubject');

  const cached = await loadSizeCache(course.subjectCode);
  if (cached) {
    for (const [name, count] of Object.entries(cached.counts)) patchRow(name, { count });
    state.sizeAt = cached.at;
    state.sizeFresh = false;
    scheduleRender();
  }

  const res = await fap.fetchClassSizes(course.subjectCode, {
    deptHints: deptBySubject[course.subjectCode] || [],
    wanted: state.page.options.map(o => o.className),
    onProgress: (m) => say(m),
    onFound: (batch) => {
      for (const x of batch) patchRow(x.className, { count: x.count });
      scheduleRender();
    }
  });

  // Any class the fresh read did not find is left blank, even if the cache has a
  // number for it — keeping the old number here means it sits there forever with
  // nobody knowing how old it is.
  const got = new Set(res.classes.map(x => x.className.toUpperCase()));
  for (const [name] of state.rows) {
    if (!got.has(name.toUpperCase())) patchRow(name, { count: null });
  }

  state.sizeAt = Date.now();
  state.sizeFresh = true;
  scheduleRender();

  await saveSizeCache(course.subjectCode, [...state.rows.values()]);

  if (res.depts && res.depts.length) {
    deptBySubject[course.subjectCode] = res.depts;
    await chrome.storage.local.set({ deptBySubject });
  }
}

function patchRow(className, patch) {
  const key = String(className).toUpperCase();
  for (const [name, row] of state.rows) {
    if (name.toUpperCase() === key) { state.rows.set(name, { ...row, ...patch }); return; }
  }
}

/* ── Cache ────────────────────────────────────────────────────── */

async function loadCache(subject, options) {
  const hit = await store.get('sched:' + subject, store.TTL.sched);
  if (!hit) return null;

  // The cache must cover EVERY class in the dropdown. One missing class means
  // rescanning: the school opening extra classes mid-term is routine, and a
  // newly opened class is exactly the one the user most needs to see.
  const known = new Set(hit.data.map(r => r.className.toUpperCase()));
  if (!options.every(o => known.has(o.className.toUpperCase()))) return null;

  // `value` ALWAYS comes from the dropdown just loaded, never from cache: using
  // an old value after the portal renumbers moves you into the wrong class — a
  // real failure, not a display glitch.
  const sched = new Map(hit.data.map(r => [r.className.toUpperCase(), r.schedule]));
  return {
    at: hit.at,
    rows: options.map(o => ({ ...o, schedule: sched.get(o.className.toUpperCase()) || 'N/A' }))
  };
}

async function saveCache(subject, rows) {
  if (!rows.some(r => r.schedule && r.schedule !== 'N/A')) return;
  await store.set('sched:' + subject, rows.map(r => ({ className: r.className, schedule: r.schedule })));
}

async function loadSizeCache(subject) {
  const hit = await store.get('size:' + subject, store.TTL.size);
  return hit ? { at: hit.at, counts: hit.data } : null;
}

async function saveSizeCache(subject, rows) {
  const counts = {};
  for (const r of rows) if (typeof r.count === 'number') counts[r.className.toUpperCase()] = r.count;
  if (Object.keys(counts).length) await store.set('size:' + subject, counts);
}

function describeAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 20) return 'vừa xong';
  if (s < 60) return `${s} giây trước`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} giờ trước` : `${Math.round(h / 24)} ngày trước`;
}

/* ── Derived display data ─────────────────────────────────────── */

function sessionsOf(item) {
  if (item.sessions && item.sessions.length) return item.sessions;
  if (!item.schedule) return [];
  return parseSessions(item.schedule);
}

const dayLabel = (i) => [...new Set(sessionsOf(i).map(s => WEEKDAYS[s.dayIndex]))].join(' + ');
const slotOf = (i) => (sessionsOf(i)[0] || {}).slot || 0;
const roomOf = (i) => {
  const s = sessionsOf(i).find(x => x.room);
  return s ? (s.room.startsWith('P.') ? s.room : 'P.' + s.room) : '';
};

/**
 * The common prefix shared by every class name in the subject.
 *
 * A subject's classes usually differ only in the tail: WDU203C_FA26_01, _02,
 * _09… Grid cells are narrow, so truncating cuts off exactly that tail — turning
 * the whole table into a column of identical strings. Dropping the prefix leaves
 * precisely the distinguishing part.
 *
 * Matching is CASE-INSENSITIVE: the portal writes the enrolled class as
 * "WDU203c_FA26_09" and open classes as "WDU203C_FA26_01" — one letter apart.
 *
 * Soft-skill subjects like SSG105 name classes after the major (AI2003, SE2040)
 * and have no common prefix, so the function returns empty and names are left
 * intact — it adapts on its own.
 */
function commonPrefix(names) {
  if (names.length < 2) return '';
  const lower = names.map(n => n.toLowerCase());
  const first = lower[0];
  let len = 0;
  while (len < first.length && lower.every(n => n[len] === first[len])) len++;

  // Back off to the last _ or -: cutting mid-token leaves remainders like "26_01"
  const cut = Math.max(first.lastIndexOf('_', len - 1), first.lastIndexOf('-', len - 1));
  if (cut <= 0) return '';

  const prefix = names[0].slice(0, cut + 1);
  return names.every(n => n.length > prefix.length) ? prefix : '';
}

function ranked() {
  return rankCandidates(evaluateCandidates([...state.rows.values()], state.busy));
}

/** Crowding relative to the subject's fullest class — the baseline comes from
 *  the data on screen */
function level(count, max) {
  if (typeof count !== 'number' || !max) return 'none';
  const r = count / max;
  return r >= 1 ? 'high' : r >= 0.75 ? 'mid' : 'low';
}

/* ── Rendering ────────────────────────────────────────────────── */

function renderClasses() {
  const rows = ranked();
  renderMeta();
  renderAdvice(rows);

  const box = $('#classes');
  box.textContent = '';
  box.appendChild(state.view === 'grid' ? renderTimetable(rows) : renderRank(rows));
  renderLegend();
}

function renderMeta() {
  const box = $('#meta');
  box.textContent = '';

  if (state.sizeAt) {
    const a = el('span', 'age ' + (state.sizeFresh ? 'fresh' : 'stale'));
    a.textContent = state.sizeFresh
      ? `Sĩ số ${describeAge(Date.now() - state.sizeAt)}`
      : `Sĩ số từ bản lưu ${describeAge(Date.now() - state.sizeAt)} · đang đọc lại…`;
    box.appendChild(a);
  }

  if (state.schedAt) {
    box.appendChild(el('span', 'faint', state.schedFromCache
      ? `Lịch lớp từ bản lưu ${describeAge(Date.now() - state.schedAt)}`
      : 'Lịch lớp vừa quét'));
  }

  const prefix = commonPrefix([...state.rows.keys()]);
  if (prefix) {
    const p = el('span', 'prefix');
    p.appendChild(document.createTextNode('Tên lớp bỏ tiền tố chung '));
    p.appendChild(el('b', null, prefix));
    box.appendChild(p);
  }
}

function renderAdvice(rows) {
  const box = $('#advice');
  box.textContent = '';
  box.className = 'advice';

  // Clash detection off: say plainly that nothing has been checked, do not stay
  // silent. Silence reads as "checked, and nothing clashes" — a conclusion the
  // tool has not reached.
  if (!state.advice) {
    box.classList.add('warn');
    box.appendChild(document.createTextNode('Chưa dò trùng giờ với các môn khác.'));
    const on = el('button', 'pick', 'Bật dò trùng giờ');
    on.addEventListener('click', () => $('#advice-toggle').click());
    box.appendChild(on);
    return;
  }

  if (!rows.some(r => r.schedule)) { box.classList.add('hidden'); return; }

  if (!state.busyKnown) {
    box.classList.add('warn');
    box.appendChild(document.createTextNode('Chưa đọc được lịch các môn khác — chưa kiểm tra được trùng giờ.'));
    return;
  }

  const sum = summarizeAdvice(rows);
  box.appendChild(document.createTextNode(`${sum.feasible}/${sum.total} lớp không trùng giờ môn nào.`));

  if (sum.best) {
    box.appendChild(document.createTextNode(' Nên chọn '));
    box.appendChild(el('b', null, sum.best.className));
    box.appendChild(document.createTextNode(` — ${describeReason(sum.best, WEEKDAYS)}`));
    const go = el('button', 'pick', 'Săn lớp này');
    go.addEventListener('click', () => startHunt(sum.best));
    box.appendChild(go);
  }
}

/* ── View A: the timetable ───────────────────────────────────── */

function renderTimetable(rows) {
  const frag = document.createDocumentFragment();

  const cells = {};
  const slots = new Set();
  const days = new Set();
  const all = state.current ? [...rows, state.current] : rows;

  for (const item of all) {
    for (const ses of sessionsOf(item)) {
      if (!ses.slot || ses.dayIndex === undefined) continue;
      slots.add(ses.slot);
      days.add(ses.dayIndex);
      (cells[`${ses.slot}|${ses.dayIndex}`] ||= []).push({ item, room: ses.room });
    }
  }

  if (!slots.size) {
    frag.appendChild(el('div', 'rail-note', 'Chưa có lịch lớp nào — đang tải…'));
    return frag;
  }

  const max = Math.max(0, ...rows.map(r => (typeof r.count === 'number' ? r.count : 0)));
  const prefix = commonPrefix([...state.rows.keys()]);
  const short = (n) => (prefix && n.length > prefix.length ? n.slice(prefix.length) : n);
  const dayList = [...days].sort((a, b) => a - b);

  const grid = el('div', 'tt');
  grid.style.gridTemplateColumns = `112px repeat(${dayList.length}, minmax(0, 1fr))`;

  grid.appendChild(el('div'));
  for (const d of dayList) grid.appendChild(el('div', 'tt-h', WEEKDAYS[d]));

  for (const slot of [...slots].sort((a, b) => a - b)) {
    const head = el('div', 'tt-slot');
    head.appendChild(el('b', null, 'Slot ' + slot));
    const t = slotTimeLabel(slot);
    head.appendChild(el('span', t ? '' : 'unknown', t || 'giờ chưa rõ'));
    grid.appendChild(head);

    for (const d of dayList) {
      const box = el('div');
      const list = cells[`${slot}|${d}`] || [];

      // Enrolled class first in the cell, then the roomiest — this whole screen
      // exists to answer "which class can I get into", and the emptiest class is
      // the easiest one to get into.
      list.sort((a, b) => {
        const cur = (b.item.current === true) - (a.item.current === true);
        if (cur) return cur;
        const na = typeof a.item.count !== 'number';
        const nb = typeof b.item.count !== 'number';
        if (na !== nb) return na ? 1 : -1;
        return (a.item.count || 0) - (b.item.count || 0);
      });

      for (const { item, room } of list) box.appendChild(makeCell(item, room, max, short));
      if (!list.length) box.appendChild(el('div', 'tt-empty', '·'));
      grid.appendChild(box);
    }
  }

  frag.appendChild(grid);
  return frag;
}

function makeCell(item, room, max, short) {
  const clash = item.clashes && item.clashes.length;
  const lv = level(item.count, max);

  const b = el('button', 'cell' + (item.current ? ' cur' : clash ? ' clash' : ''));
  b.title = item.className;

  // Background partly filled by crowding: readable at a glance, before the number
  if (!item.current && !clash && typeof item.count === 'number' && max) {
    const fill = el('div', 'fill ' + lv);
    fill.style.width = `${Math.round(Math.min(1, item.count / max) * 100)}%`;
    b.appendChild(fill);
  }
  if (clash) b.appendChild(el('div', 'hatch'));

  const body = el('div', 'body');

  const nm = el('div', 'nm');
  if (item.current) nm.appendChild(el('span', null, '★'));
  else if (clash) nm.appendChild(el('span', null, '▲'));
  nm.appendChild(el('span', 'name', short(item.className)));
  body.appendChild(nm);

  const sub = el('div', 'sub');
  if (clash) {
    sub.appendChild(el('span', 'why', 'trùng ' + (item.clashes[0].subjectCode || '')));
  } else {
    sub.appendChild(el('span', 'room', room ? (room.startsWith('P.') ? room : 'P.' + room) : ''));
  }

  if (item.current) {
    sub.appendChild(el('span', 'tagcur', 'đang học'));
  } else if (typeof item.count === 'number') {
    sub.appendChild(el('span', 'cnt ' + lv, item.count));
    sub.appendChild(el('span', 'unit', 'sv'));
  } else if (item.count === null) {
    sub.appendChild(el('span', 'cnt none', '—'));
  } else {
    sub.appendChild(el('span', 'skel'));
  }
  body.appendChild(sub);

  b.appendChild(body);
  if (item.current) b.disabled = true;
  else b.addEventListener('click', () => startHunt(item));
  return b;
}

/* ── View B: the ranked list ─────────────────────────────────── */

function renderRank(rows) {
  const max = Math.max(0, ...rows.map(r => (typeof r.count === 'number' ? r.count : 0)));
  const box = el('div', 'rank');

  const head = el('div', 'rrow rhead');
  for (const t of ['#', 'Lớp', 'Lịch', 'Phòng', 'Sĩ số', '']) head.appendChild(el('div', null, t));
  box.appendChild(head);

  if (state.current) {
    const tr = el('div', 'rrow cur');
    tr.appendChild(el('div', 'pos', '★'));
    tr.appendChild(el('div', 'nm', state.current.className));
    tr.appendChild(el('div', 'when', `${dayLabel(state.current)} · Slot ${slotOf(state.current)}`));
    tr.appendChild(el('div', 'room', roomOf(state.current)));
    tr.appendChild(el('div', null, 'đang học'));
    tr.appendChild(el('div', 'n', ''));
    box.appendChild(tr);
  }

  let pos = 0;
  for (const item of rows) {
    const clash = item.clashes && item.clashes.length;
    if (!clash) pos++;

    const lv = level(item.count, max);
    const tr = el('button', 'rrow' + (clash ? ' clash' : ''));
    tr.title = item.className;

    tr.appendChild(el('div', 'pos' + (!clash && pos <= 2 ? ' top' : ''), clash ? '—' : String(pos)));
    tr.appendChild(el('div', 'nm', item.className));

    if (clash) {
      tr.appendChild(el('div', 'when', 'trùng ' + (item.clashes[0].subjectCode || '')));
    } else if (item.schedule === null) {
      const w = el('div', 'when');
      w.appendChild(el('span', 'skel'));
      tr.appendChild(w);
    } else {
      tr.appendChild(el('div', 'when', `${dayLabel(item) || '—'} · Slot ${slotOf(item) || '?'}`));
    }

    tr.appendChild(el('div', 'room', roomOf(item)));

    // The bar length is the fastest thing to read here: longer = fuller = harder
    // to get into
    const track = el('div', 'track');
    if (typeof item.count === 'number' && max) {
      const i = el('i', lv);
      i.style.width = `${Math.round(Math.min(1, item.count / max) * 100)}%`;
      track.appendChild(i);
    }
    tr.appendChild(track);

    if (typeof item.count === 'number') tr.appendChild(el('div', 'n ' + lv, item.count));
    else if (item.count === null) tr.appendChild(el('div', 'n none', '—'));
    else { const n = el('div', 'n'); n.appendChild(el('span', 'skel')); tr.appendChild(n); }

    tr.addEventListener('click', () => startHunt(item));
    box.appendChild(tr);
  }

  return box;
}

function renderLegend() {
  const box = $('#legend');
  box.textContent = '';

  const add = (cls, text) => {
    const s = el('span');
    s.appendChild(el('i', cls));
    s.appendChild(document.createTextNode(text));
    box.appendChild(s);
  };

  if (state.view === 'grid') add('grad', 'Nền càng đầy, lớp càng đông');
  add('ok', 'Thoáng');
  add('warn', 'Gần đầy');
  add('err', 'Đông nhất');
  if (state.current) add('cur', 'Lớp đang học');
  if (state.advice) add('hatch', 'Trùng giờ môn khác');

  box.appendChild(el('span', 'note', 'FAP không cho biết sức chứa — màu so theo lớp đông nhất của môn'));
}

/* ── Roster of the current class ──────────────────────────────── */

/**
 * Only the class YOU ARE ENROLLED IN can be viewed — a limit of the portal, not
 * of the tool.
 *
 * groupId comes from the MoveSubject.aspx?id=<id> URL, and that id is the same
 * group id used by Groups.aspx?group=<id>. Arbitrary ids are deliberately NOT
 * accepted: enumerating numbers in the URL would pull rosters of classes you are
 * not in, which amounts to collecting strangers' information.
 */
async function showRoster() {
  const page = state.page;
  if (!page || !page.groupId) { say('Chưa mở môn nào'); return; }

  showPane('#pane-roster');
  $('#roster-name').textContent = page.currentClass || state.currentName || '';
  $('#roster-count').textContent = '';
  $('#roster-photos').textContent = '';
  const box = $('#roster');
  box.textContent = '';

  let members;
  try {
    members = await fap.getRoster(page.groupId);
  } catch (e) {
    box.appendChild(el('div', 'rail-note', 'Không đọc được danh sách: ' + e.message));
    return;
  }

  if (!members.length) {
    box.appendChild(el('div', 'rail-note', 'Trang không có dòng sinh viên nào.'));
    return;
  }

  $('#roster-count').textContent = `${members.length} sinh viên`;
  const slots = new Map();

  for (const m of members) {
    const card = el('div', 'person');
    const av = el('div', 'avatar');
    av.appendChild(el('span', 'initials', (m.name || m.roll).trim().slice(0, 1).toUpperCase()));
    card.appendChild(av);
    slots.set(m.roll, av);

    const who = el('div', 'who');
    who.appendChild(el('b', null, m.name || '—'));
    who.appendChild(el('span', null, m.roll));
    card.appendChild(who);
    box.appendChild(card);
  }

  let loaded = 0;
  await fap.fetchPhotos(members, (roll, dataUrl) => {
    loaded++;
    $('#roster-photos').textContent = loaded < members.length ? `Ảnh ${loaded}/${members.length}` : '';
    const av = slots.get(roll);
    if (!av || !dataUrl) return;
    av.textContent = '';
    const img = el('img');
    img.src = dataUrl;
    img.alt = '';
    av.appendChild(img);
  });
}

/* ── Confirmation ─────────────────────────────────────────────── */

/**
 * Confirm before hunting — for EVERY class, not just clashing ones.
 *
 * In both the grid and the list the whole cell/row is clickable, which is a very
 * large target, so mis-clicks will happen. And a mis-click here is not a
 * one-beat annoyance: the tool starts hammering Save for a class the user never
 * meant to enter, and may actually move them into it.
 *
 * The dialog states FROM where TO where, rather than asking a blank "are you
 * sure?" — nobody reads that one before clicking OK.
 */
function confirmMove(item) {
  const dlg = $('#confirm');
  const body = $('#confirm-body');
  body.textContent = '';

  const max = Math.max(0, ...[...state.rows.values()].map(r => (typeof r.count === 'number' ? r.count : 0)));

  const leg = (cls, kicker, name, when) => {
    const d = el('div', 'leg' + (cls ? ' ' + cls : ''));
    d.appendChild(el('i'));
    const t = el('div');
    t.style.flex = '1';
    t.appendChild(el('div', 'k', kicker));
    t.appendChild(el('div', 'v', name));
    t.appendChild(el('div', 'w', when));
    d.appendChild(t);
    body.appendChild(d);
  };

  const desc = (x) => {
    const parts = [dayLabel(x), slotOf(x) ? 'Slot ' + slotOf(x) : '', roomOf(x)].filter(Boolean);
    return parts.join(' · ') || 'chưa rõ lịch';
  };

  if (state.current) leg('', 'Đang học', state.current.className, desc(state.current));
  else if (state.currentName) leg('', 'Đang học', state.currentName, 'chưa đọc được lịch');

  const arrow = el('div', 'arrow');
  arrow.appendChild(svg(['M7 2v16', 'M2.5 13.5L7 18l4.5-4.5'], 16));
  body.appendChild(arrow);

  leg('to', 'Chuyển sang', item.className, desc(item));

  // Headcount with its age: this is precisely the moment the number is used to
  // make a decision
  const lv = level(item.count, max);
  const g = el('div', 'gauge');
  const top = el('div', 'top');
  top.appendChild(el('span', null, 'Sĩ số lớp mới'));
  if (typeof item.count === 'number') {
    top.appendChild(el('span', 'n ' + lv, item.count));
    top.appendChild(el('span', null, `/ ${max} lớp đông nhất`));
  } else {
    top.appendChild(el('span', 'n none', '—'));
    top.appendChild(el('span', null, 'chưa đọc được'));
  }
  g.appendChild(top);

  if (typeof item.count === 'number' && max) {
    const barBox = el('div', 'bar');
    const i = el('i');
    i.style.width = `${Math.round(Math.min(1, item.count / max) * 100)}%`;
    i.style.background = `var(--${lv === 'high' ? 'err' : lv === 'mid' ? 'warn' : 'ok'})`;
    barBox.appendChild(i);
    g.appendChild(barBox);
  }
  if (state.sizeAt) g.appendChild(el('div', 'when', `Đọc ${describeAge(Date.now() - state.sizeAt)}`));
  body.appendChild(g);

  if (item.clashes && item.clashes.length) {
    const w = el('div', 'cwarn');
    w.appendChild(svg([
      'M12 8v5', 'M12 17h.01',
      'M10.3 3.9L2.4 17.5A1.9 1.9 0 0 0 4 20.4h16a1.9 1.9 0 0 0 1.6-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0z'
    ], 16));
    const t = el('div');
    t.appendChild(el('b', null, 'Trùng giờ với ' + (item.clashes[0].subjectCode || '')));
    t.appendChild(el('span', null, item.clashes
      .map(x => `${WEEKDAYS[x.dayIndex]} slot ${x.slot}`).join(', ') + ' — bạn sẽ không học được cả hai.'));
    w.appendChild(t);
    body.appendChild(w);
  }

  return new Promise((resolve) => {
    const done = (ok) => {
      dlg.close();
      $('#confirm-yes').removeEventListener('click', yes);
      $('#confirm-no').removeEventListener('click', no);
      dlg.removeEventListener('cancel', no);
      resolve(ok);
    };
    const yes = () => done(true);
    const no = () => done(false);

    $('#confirm-yes').addEventListener('click', yes);
    $('#confirm-no').addEventListener('click', no);
    dlg.addEventListener('cancel', no);   // the Esc key

    dlg.showModal();
    // Focus starts on Cancel: a stray Enter press should result in nothing
    // happening, not in a class move starting.
    $('#confirm-no').focus();
  });
}

/* ── Slot hunting ─────────────────────────────────────────────── */

async function startHunt(item) {
  if (!item || !item.value) return;
  if (!(await confirmMove(item))) return;

  // The user may have pressed "Stop waiting" earlier; starting a hunt is a fresh
  // decision, so re-enable waiting.
  fap.resetCancel();

  showPane('#pane-hunt');
  $('#hunt-target').textContent = item.className;
  $('#hunt-log').textContent = '';
  $('#hunt-state').classList.add('hidden');
  state.hunting = true;

  const started = Date.now();
  let n = 0;

  const log = (text, kind) => {
    const box = $('#hunt-log');
    const row = el('div');
    row.appendChild(el('span', 't', new Date().toLocaleTimeString('vi-VN', { hour12: false })));
    row.appendChild(el('span', kind || 'dim', text));
    box.insertBefore(row, box.firstChild);
  };

  const stats = () => {
    const box = $('#hunt-stats');
    box.textContent = '';
    const add = (v, k, unit) => {
      const d = el('div');
      const val = el('div', 'v', v);
      if (unit) val.appendChild(el('small', null, unit));
      d.appendChild(val);
      d.appendChild(el('div', 'k', k));
      box.appendChild(d);
    };
    const s = Math.floor((Date.now() - started) / 1000);
    add(n, 'Lần thử');
    add(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, 'Đã chạy');
    add(typeof item.count === 'number' ? item.count : '—', 'Sĩ số lúc mở', 'sv');
  };

  const setState = (text, ok) => {
    const box = $('#hunt-state');
    box.className = 'hunt-state' + (ok ? ' ok' : '');
    box.textContent = text;
  };

  log('Bắt đầu săn ' + item.className, 'info');
  stats();

  while (state.hunting) {
    n++;
    stats();
    try {
      const r = await fap.trySave(state.page, item.value);

      if (r.ok) {
        log('THÀNH CÔNG — ' + r.message, 'ok');
        setState(`Đã chuyển sang lớp ${item.className}.`, true);
        state.hunting = false;
        stats();
        await afterMoved();
        return;
      }

      if (r.kind === 'SESSION') {
        log('Mất phiên đăng nhập', 'warn');
        setState('Mất phiên đăng nhập — đăng nhập lại FAP rồi bắt đầu lại.');
        state.hunting = false;
        break;
      }

      log(r.message, 'warn');
      setState(r.message + ' — thử lại sau 1,2 giây.');
    } catch (e) {
      // Congestion is already retried indefinitely by the layer below; reaching
      // here means the error is not of the retryable kind.
      log(e.message, 'warn');
      setState(e.message);
      if (e.kind === 'CANCELLED') { state.hunting = false; break; }
      await sleep(4000);
    }

    await sleep(1200);
  }

  stats();
}

/**
 * Cleanup after a successful class move.
 *
 * The SCHEDULE cache is kept — the schedules of open classes do not change
 * because you moved. But everything describing "the class I am in" is now stale
 * and must be re-read FROM THE PORTAL, not inferred from the class just entered:
 * the portal is the source of truth, and if the move was not recorded for any
 * reason, that has to show up immediately.
 */
async function afterMoved() {
  await store.drop('att', 'courses');

  state.subject = null;
  state.rows = new Map();
  state.current = null;

  say('Đã chuyển lớp — đang đọc lại danh sách môn…');
  try {
    const c = await store.cached('courses', store.TTL.courses, fap.getEnrolledCourses);
    state.courses = c.data;
    renderSubjects();
    say('Đã chuyển lớp xong');
  } catch (e) {
    say('Đã chuyển lớp, nhưng chưa đọc lại được danh sách môn: ' + e.message);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── Buttons ──────────────────────────────────────────────────── */

function renderAdviceToggle() {
  const b = $('#advice-toggle');
  b.textContent = '';
  b.appendChild(el('i', 'dot'));
  b.appendChild(document.createTextNode(state.advice ? 'Dò trùng giờ: bật' : 'Dò trùng giờ: tắt'));
  b.classList.toggle('on', state.advice);
}

/**
 * The banner shown while the portal is congested.
 *
 * Retrying forever in silence is indistinguishable from hanging. This banner
 * states what is being waited on, which attempt this is, and how long is left —
 * and it offers a stop, because patience has to be the user's choice rather than
 * something the tool imposes.
 */
fap.setRetryReporter((err, attempt, wait) => {
  const box = $('#lagbar');
  if (!err) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('#lagtext').textContent = `${err.message} — thử lại lần ${attempt}, chờ ${Math.round(wait / 1000)}s`;
});

$('#lagstop').addEventListener('click', () => {
  fap.cancelAll();
  $('#lagbar').classList.add('hidden');
  say('Đã dừng chờ FAP');
});

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab[data-view]');
  if (!tab) return;
  document.querySelectorAll('.tab[data-view]').forEach(t => t.classList.remove('on'));
  tab.classList.add('on');
  state.view = tab.dataset.view;
  renderClasses();
});

/**
 * Toggles CLASH DETECTION — not the attendance page as a whole.
 *
 * The enrolled class is always read: it is the baseline for comparison and comes
 * from the same read anyway, so switching it off would save nothing. This button
 * only decides whether a busy-hours map is built from the other subjects.
 */
$('#advice-toggle').addEventListener('click', async () => {
  state.advice = !state.advice;
  renderAdviceToggle();
  await store.set('settings', { advice: state.advice });

  if (state.subject) {
    await loadCurrentSchedules(state.subject);
    scheduleRender();
  }
});

$('#login-open').addEventListener('click', async () => {
  // Opened in the foreground: the user needs to see the page to type into it.
  // Quite unlike the bridge tab, which is opened silently because nobody has to
  // look at it.
  await chrome.tabs.create({ url: 'https://fap.fpt.edu.vn/', active: true });
  waitForLogin();
});

$('#roster-btn').addEventListener('click', showRoster);
$('#roster-close').addEventListener('click', () => showPane('#pane-classes'));

$('#stop').addEventListener('click', () => {
  state.hunting = false;
  fap.cancelAll();
  say('Đã dừng săn');
});

$('#rescan').addEventListener('click', () => {
  if (state.subject) openSubject(state.subject, true);
});

/**
 * Reload: wipe EVERYTHING remembered and read it all again from scratch.
 *
 * Deliberately wipes everything rather than just refreshing what is on screen.
 * This button gets pressed exactly when the user suspects the data is wrong —
 * and at that moment they do not know which part is wrong, so a half-hearted
 * wipe would leave behind the very thing causing the confusion. Settings are
 * left alone.
 */
$('#reload').addEventListener('click', async () => {
  if (!confirm('Xoá toàn bộ dữ liệu đã lưu và đọc lại từ FAP?')) return;

  fap.resetCancel();
  const n = await store.clearAll();

  showPane('#pane-empty');
  state.subject = null;
  state.rows = new Map();
  state.current = null;
  state.sizeAt = 0;
  $('#subjects').textContent = '';

  say(`Đã xoá ${n} mục đã lưu — đang đọc lại…`);
  await boot(true);
});

$('#build-dept').addEventListener('click', async () => {
  try {
    const map = await fap.buildDeptMap(say);
    say(`Đã tạo bảng khoa: ${map.departments.length} khoa, ${Object.keys(map.subjects).length} mã môn`);
  } catch (e) {
    say('Không tạo được bảng khoa: ' + e.message);
  }
});

boot();
