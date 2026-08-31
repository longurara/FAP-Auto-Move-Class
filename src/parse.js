/**
 * PARSERS FOR THE PORTAL — the in-browser build.
 *
 * The CLI build uses cheerio because it runs on Node. Here DOMParser is already
 * in the browser, so it is used directly: lighter, and more importantly the same
 * HTML parsing engine Chrome itself uses, so the places where the portal emits
 * non-conforming HTML break IDENTICALLY to what you see with your own eyes in
 * the browser — predictable, rather than drifting silently between two parsers.
 *
 * Every trap below was found the hard way; the notes are kept verbatim.
 */

const FAP_BASE = 'https://fap.fpt.edu.vn';

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

export function toDoc(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

/* ── Weekdays ─────────────────────────────────────────────────── */

export const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

const DAY_MAP = {
  mon: 0, monday: 0, tue: 1, tuesday: 1, wed: 2, wednesday: 2,
  thu: 3, thursday: 3, fri: 4, friday: 4, sat: 5, saturday: 5,
  sun: 6, sunday: 6
};

/**
 * Split the sessions out of MoveSubject's lblNewSlot string.
 *
 * The real string the portal returns:
 *   "Mon :Slot: 1 - RoomNo: P.118 - Lecture: ,
 *    Thu :Slot: 1 - RoomNo: P.118 - Lecture: ,"
 *
 * Do NOT "tidy" the string before splitting. The CLI build used to strip
 * "Lecture:" and its trailing comma for neatness — which also stripped the COMMA
 * SEPARATING the two sessions, gluing them together so only the first day was
 * read. The output looked like the portal reporting a single session, and nearly
 * led to building a whole mechanism for inferring the missing one.
 *
 * The separator may be a comma or a <br> (which becomes a newline).
 */
export function parseSessions(raw) {
  const out = [];
  for (const chunk of String(raw || '').split(/[,\n\r]+/)) {
    const t = chunk.trim();
    if (!t) continue;

    const day = t.match(/^([A-Za-z]{3,9})\s*:/);
    const slot = t.match(/Slot:?\s*(\d{1,2})/i);
    if (!day || !slot) continue;

    const idx = DAY_MAP[day[1].toLowerCase().slice(0, 3)];
    if (idx === undefined) continue;

    const room = t.match(/RoomNo:?\s*([^\-,]+)/i);
    out.push({
      dayIndex: idx,
      label: WEEKDAYS[idx],
      slot: parseInt(slot[1], 10),
      room: room ? clean(room[1]) : ''
    });
  }
  return out;
}

/**
 * The clock time of each slot.
 *
 * SOURCE: the real weekly timetable, not guesswork. The CLI build once hardcoded
 * times that were off by 30 minutes — slot 2 listed as 10:00–12:20 when it is
 * actually 09:30–11:45.
 *
 * `true`   = read directly off the attendance page or the weekly timetable
 * `false`  = inferred from the rhythm of the confirmed slots, shown with a ?
 * missing  = no basis at all, so NO time is invented
 *
 * The confirmed rhythm: 2h15 per slot, 15-minute breaks, 45 minutes at midday.
 */
const SLOT_TIMES = {
  1: { time: '07:00 – 09:15', sure: false },
  2: { time: '09:30 – 11:45', sure: true },
  3: { time: '12:30 – 14:45', sure: true },
  4: { time: '15:00 – 17:15', sure: true }
};

/** Load real times read off the attendance page ("7_(17:45-19:15)") */
export function learnSlotTimes(map) {
  let n = 0;
  for (const [slot, time] of Object.entries(map || {})) {
    if (!time) continue;
    SLOT_TIMES[slot] = { time: String(time).replace(/-/g, ' – '), sure: true };
    n++;
  }
  return n;
}

/**
 * The time label for a slot. Unknown returns an empty string — better to show
 * nothing than something wrong, because a wrong time leads straight to picking
 * the wrong class.
 */
export function slotTimeLabel(slot) {
  const e = SLOT_TIMES[slot];
  if (!e) return '';
  return e.sure ? e.time : e.time + ' ?';
}

/* ── Courses.aspx (FrontOffice) — enrolled subjects ───────────── */

/**
 * The enrolled-subjects table on FrontOffice/Courses.aspx.
 *
 * The REAL structure (verified against the working CLI build, not guessed):
 *   table  #ctl00_mainContent_gvCourses
 *   row    >= 7 cells
 *   cell 0  current class name    cell 1  subject code
 *   cell 2  slot                  cell 3  room
 *
 * Most important of all: the move-class control is NOT an ordinary link. It is
 * an ASP.NET LinkButton whose href is javascript:__doPostBack('<target>','').
 * Searching for a[href*="MoveSubject.aspx"] finds nothing — the MoveSubject page
 * only appears AFTER that target is POSTed.
 */
export function parseEnrolledCourses(html) {
  const doc = toDoc(html);
  const gv = doc.querySelector('#ctl00_mainContent_gvCourses');
  if (!gv) return [];

  const out = [];
  for (const tr of gv.querySelectorAll('tr')) {
    const cols = tr.querySelectorAll('td');
    if (cols.length < 7) continue;

    const currentClass = clean(cols[0].textContent);
    const subjectCode = clean(cols[1].textContent);
    const link = tr.querySelector('a[id*="lkMoveGroup"]');
    if (!subjectCode || !currentClass || !link) continue;

    // Read BOTH arguments of __doPostBack('<target>', '<argument>').
    //
    // The previous version took only the first and sent an empty argument. With
    // an ordinary LinkButton the target already identifies the row, so that was
    // fine — but if the portal uses the __doPostBack('…$gvCourses', 'Select$2')
    // form, the ROW lives in the SECOND argument, and sending an empty one means
    // selecting no row at all. The server then keeps whatever subject is already
    // in the session, so every subject you click returns the same one.
    //
    // Do not guess which form the portal uses — read the string it actually
    // wrote.
    const href = link.getAttribute('href') || '';
    const call = href.match(/__doPostBack\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/);

    out.push({
      subjectCode,
      currentClass,
      slot: clean(cols[2].textContent),
      room: clean(cols[3].textContent),
      postbackTarget: call ? call[1] : ((href.match(/__doPostBack\('([^']*)'/) || [])[1] || link.id),
      postbackArg: call ? call[2] : ''
    });
  }

  return out;
}

/* ── MoveSubject.aspx — the open classes ──────────────────────── */

export function parseMoveOptions(html) {
  const doc = toDoc(html);
  const sel = doc.querySelector('#ctl00_mainContent_dllCourse, select[name*="dllCourse"]');
  if (!sel) return [];

  return [...sel.options]
    .filter(o => o.value)
    .map(o => ({ value: o.value, className: clean(o.textContent).toUpperCase() }));
}

/** Schedule of the class selected on MoveSubject, string kept VERBATIM */
export function parseNewSlot(html) {
  const el = toDoc(html).querySelector('#ctl00_mainContent_lblNewSlot');
  if (!el) return '';
  // Collapse HORIZONTAL whitespace only. Keep newlines, because a <br> is also
  // a session boundary.
  return el.innerText !== undefined
    ? el.innerText.replace(/[ \t]+/g, ' ').trim()
    : el.textContent.replace(/[ \t]+/g, ' ').trim();
}

/**
 * The subject the MoveSubject page is actually showing.
 *
 * This has to be read for CROSS-CHECKING; the subject that was requested cannot
 * be trusted. If the page returns the wrong subject while the UI still shows the
 * name that was clicked, the user has no way of knowing — and at worst ends up
 * hunting a class belonging to a different subject.
 */
export function parseSubjectLabel(html) {
  const el = toDoc(html).querySelector('#ctl00_mainContent_lblSubject');
  return el ? clean(el.textContent) : '';
}

/** Current class: the portal drops it from the dropdown, leaving only this label */
export function parseOldGroup(html) {
  const el = toDoc(html).querySelector('#ctl00_mainContent_lblOldGroup');
  return el ? clean(el.textContent) : '';
}

/* ── Report/ViewAttendstudent.aspx — real enrolled schedules ──── */

export function parseCourseList(html) {
  const doc = toDoc(html);
  const student = clean(doc.querySelector('#ctl00_mainContent_lblStudent')?.textContent);
  const roll = (student.match(/\(([^)]+)\)\s*$/) || [])[1] || '';

  const courses = [];
  let campus = '';
  let term = '';

  for (const td of doc.querySelectorAll('#ctl00_mainContent_divCourse td')) {
    const text = clean(td.textContent);
    if (!text) continue;

    const link = td.querySelector('a');
    const href = link ? link.getAttribute('href') || '' : '';
    const courseId = (href.match(/course=(\d+)/) || [])[1] || '';
    if (!campus) campus = (href.match(/campus=(\d+)/) || [])[1] || '';
    if (!term) term = (href.match(/term=(\d+)/) || [])[1] || '';

    courses.push({
      courseId,
      subjectCode: (text.match(/\(([A-Z]{2,4}\d{3}[a-z]?)\)/) || [])[1] || '',
      className: (text.match(/\(([^(),]+),\s*start/i) || [])[1] || '',
      // The currently selected subject sits in a <b> with no href
      selected: !link
    });
  }

  return { roll, campus, term, courses };
}

/**
 * The session table on the attendance page.
 *
 * Do NOT look it up via #divDetail. The portal's HTML is non-conforming:
 * <div id="divDetail"> sits directly inside a <tr>. The browser handles that by
 * foster parenting — pushing the div OUTSIDE the table and leaving an EMPTY div
 * behind, while the detail table stays inside. Selecting by id gets you the
 * empty shell, no rows, and it all looks like "the page returned nothing" even
 * though it was HTTP 200 with the data all present.
 *
 * Searching by CONTENT is immune: the session table is the only one with cells
 * shaped like "2_(9:30-11:45)". When several nested tables match, take the
 * INNERMOST one.
 */
export function parseAttendanceDetail(html) {
  const doc = toDoc(html);

  const tables = [...doc.querySelectorAll('table')]
    .filter(t => /\d{1,2}_\(/.test(t.textContent || ''))
    .sort((a, b) => a.querySelectorAll('table').length - b.querySelectorAll('table').length);

  const table = tables[0];
  if (!table) return { pattern: [], slotTimes: {}, total: 0, className: '' };

  const seen = new Set();
  const pattern = [];
  const slotTimes = {};
  let className = '';
  let total = 0;

  for (const tr of table.querySelectorAll('tr')) {
    const tds = [...tr.querySelectorAll('td')].map(td => clean(td.textContent));
    if (tds.length < 6) continue;

    const dayCell = tds.find(t => /^(mon|tue|wed|thu|fri|sat|sun)/i.test(t));
    const slotCell = tds.find(t => /^(\d{1,2})_\(([^)]+)\)/.test(t));
    if (!dayCell || !slotCell) continue;

    const m = slotCell.match(/^(\d{1,2})_\(([^)]+)\)/);
    const slot = parseInt(m[1], 10);
    const time = m[2];
    const dayIndex = DAY_MAP[dayCell.toLowerCase().slice(0, 3)];
    if (dayIndex === undefined) continue;

    slotTimes[slot] = time;
    total++;

    const room = tds.find(t => /^P?\.?\s?\d{3}/.test(t)) || '';
    if (!className) {
      className = tds.find(t => /^[A-Z]{2,4}\d{3,4}([_A-Z0-9]+)?$/.test(t)) || '';
    }

    const key = `${dayIndex}|${slot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pattern.push({ dayIndex, label: WEEKDAYS[dayIndex], slot, time, room });
  }

  pattern.sort((a, b) => a.dayIndex - b.dayIndex || a.slot - b.slot);
  return { pattern, slotTimes, total, className };
}

/* ── Course/Courses.aspx — class headcounts ───────────────────── */

export function parseCampusKey(html) {
  const name = clean(toDoc(html).querySelector('#ctl00_lblCampusName')?.textContent);
  return { key: /hòa lạc|hoa lac/i.test(name) ? 'hola' : 'xavalo', name };
}

export function parseDepartments(html) {
  const doc = toDoc(html);
  const depts = [];
  let campus = '';
  let term = '';

  for (const a of doc.querySelectorAll('#ctl00_mainContent_divDepartment a')) {
    const href = a.getAttribute('href') || '';
    const dept = (href.match(/dept=(\d+)/i) || [])[1];
    if (!dept) continue;
    if (!campus) campus = (href.match(/campus=(\d+)/i) || [])[1] || '';
    if (!term) term = (href.match(/term=(\d+)/i) || [])[1] || '';
    depts.push({ dept, label: clean(a.textContent) });
  }

  return { campus, term, depts };
}

/**
 * Headcounts of a subject's classes on a department page.
 *
 *   <a href="Groups.aspx?group=61740">SE1705</a> ... | 28-(...)
 *
 * The headcount is in the TEXT IMMEDIATELY AFTER the <a>, between "|" and "-(".
 * Only that exact shape is accepted: matching "any nearby number" immediately
 * pulls 170 out of the class name "SE1705" — a plausible-looking figure nobody
 * would question, and being wrong means the user skips a class with room to hunt
 * one that is full.
 *
 * Scan EVERY matching row, not just the first. The first match may be a header
 * row containing no class link — the CLI build took the first row and concluded
 * "this department doesn't have the subject", repeated that across all 17
 * departments, and returned 0 results while the data was sitting right there.
 */
export function parseClassCounts(html, subjectCode) {
  const doc = toDoc(html);
  const want = String(subjectCode || '').trim().toLowerCase();
  const out = [];

  for (const tr of doc.querySelectorAll('#id tr')) {
    const first = clean(tr.querySelector('td')?.textContent).toLowerCase();
    if (!first.includes(want)) continue;

    for (const a of tr.querySelectorAll('a[href*="Groups.aspx"]')) {
      const groupId = ((a.getAttribute('href') || '').match(/group=(\d+)/i) || [])[1] || '';
      const className = clean(a.textContent);
      if (!className) continue;

      let raw = '';
      let node = a.nextSibling;
      while (node && !(node.nodeType === 1 && node.tagName === 'A')) {
        raw += node.textContent || '';
        node = node.nextSibling;
      }
      raw = clean(raw);

      const m = raw.match(/\|\s*(\d{1,3})\s*-\s*\(/) || raw.match(/\|\s*(\d{1,3})\b/);
      out.push({ className, groupId, count: m ? parseInt(m[1], 10) : null, raw });
    }
  }

  return out;
}

/** Subject codes present on a department page — used to build "subject -> dept" */
export function parseSubjectCodes(html) {
  const doc = toDoc(html);
  const codes = new Set();

  for (const tr of doc.querySelectorAll('#id tr')) {
    // Only count rows WITH a class link: header rows carry the subject code too,
    // but no class
    if (!tr.querySelector('a[href*="Groups.aspx"]')) continue;
    const cell = clean(tr.querySelector('td')?.textContent);
    const head = cell.split(/\s+-\s+/)[0].trim();
    const m = head.match(/^([A-Za-z]{2,4}\d{3}[A-Za-z]?)\b/);
    if (m) codes.add(m[1].toLowerCase());
  }

  return [...codes];
}

/* ── Groups.aspx — class roster ───────────────────────────────── */

export function parseRoster(html) {
  const doc = toDoc(html);
  const box = doc.querySelector('#ctl00_mainContent_divStudents');
  const table = box ? box.querySelector('table') : doc.querySelector('table[summary="Student list"]');
  if (!table) return [];

  const members = [];
  for (const tr of table.querySelectorAll('tbody tr')) {
    const tds = [...tr.querySelectorAll('td')];
    const texts = tds.map(td => clean(td.textContent));

    // The header has 7 columns but each row has only 6 cells, so mapping by
    // position is off. Locate the student ID by PATTERN, then join every cell
    // AFTER it into the full name.
    const at = texts.findIndex(t => /^[A-Za-z]{2}\d{5,7}$/.test(t));
    if (at === -1) continue;

    // Do NOT use img.src.
    //
    // A document built by DOMParser takes the base URL of the PAGE IT RUNS IN,
    // i.e. chrome-extension://<id>/. So img.src for a relative path resolves to
    // chrome-extension://<id>/Image.aspx?… — pointing at the extension itself,
    // so the image never loads and there is no clear error either.
    //
    // Read the raw attribute and join it to the portal origin by hand.
    const img = tr.querySelector('img');
    const raw = img ? img.getAttribute('src') || '' : '';
    const photo = !raw
      ? ''
      : /^https?:/i.test(raw)
        ? raw
        : FAP_BASE + (raw.startsWith('/') ? raw : '/' + raw.replace(/^\.\//, ''));

    members.push({
      roll: texts[at],
      name: texts.slice(at + 1).filter(Boolean).join(' '),
      photo
    });
  }

  return members;
}

/* ── ASP.NET forms ────────────────────────────────────────────── */

/** Every hidden input on the page — needed to POST back correctly */
export function hiddenFields(html) {
  const doc = toDoc(html);
  const data = {};
  for (const inp of doc.querySelectorAll('input[type="hidden"]')) {
    if (inp.name) data[inp.name] = inp.value || '';
  }
  return data;
}

export function isLoggedIn(html) {
  return !/Login With FeID|\/Default\.aspx/i.test(html) &&
    /ctl00_mainContent|lblStudent|Logout/i.test(html);
}
