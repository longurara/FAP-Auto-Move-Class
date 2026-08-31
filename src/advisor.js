import { parseSessions, WEEKDAYS } from './parse.js';

/**
 * WHICH CLASS TO MOVE INTO.
 *
 * The tool already knows the three things it takes to answer the user's real
 * question — "which class can I actually get into" — but it used to make them
 * read the grid and work it out themselves:
 *
 *   1. schedules of every enrolled subject  (attendance page)
 *   2. schedules of every open class        (MoveSubject)
 *   3. headcount of each class              (course browser)
 *
 * Putting the three together eliminates most of the options straight away: a
 * class that clashes with another subject is IMPOSSIBLE to attend, however much
 * room it has. That is a hard constraint, and also the easiest thing to miss
 * when scanning a six-column grid by eye.
 *
 * Deliberately does NOT move the class for you. It only ranks and states its
 * reasons — the decision stays with the user, because the tool knows nothing
 * about constraints outside the timetable (a part-time job, friends in a class,
 * a particular lecturer).
 */

const KEY = (day, slot) => `${day}|${slot}`;

/**
 * Build the "hours already taken" map from the schedules of ENROLLED subjects.
 *
 * Skip the subject being moved: you are about to leave that class, so its hours
 * are no longer a constraint. Without the skip, every class in the same slot
 * reports a clash with itself.
 *
 * @param {Array} subjects from fetchCurrentSchedules().subjects
 * @param {string} excludeSubject code of the subject being moved
 * @returns {Map<string, {subjectCode: string, className: string}>}
 */
export function buildBusyMap(subjects, excludeSubject = '') {
  const busy = new Map();
  const skip = String(excludeSubject || '').toUpperCase();

  for (const s of subjects || []) {
    if (skip && String(s.subjectCode || '').toUpperCase() === skip) continue;

    for (const p of s.pattern || []) {
      if (p.dayIndex === undefined || !p.slot) continue;
      busy.set(KEY(p.dayIndex, p.slot), {
        subjectCode: s.subjectCode || '',
        className: s.className || ''
      });
    }
  }

  return busy;
}

/** Sessions of a class, accepting either `sessions` or the raw `schedule` string */
function sessionsOf(item) {
  if (Array.isArray(item.sessions) && item.sessions.length) {
    return item.sessions.map(x => ({
      index: x.index !== undefined ? x.index : x.dayIndex,
      slot: x.slot
    }));
  }
  return parseSessions(item.schedule || '').map(x => ({ index: x.dayIndex, slot: x.slot }));
}

/**
 * Score each class: does it clash with another subject, is it crowded or roomy.
 *
 * @param {Array} classes open classes (with `count` if the headcount was read)
 * @param {Map} busy the busy-hours map
 */
export function evaluateCandidates(classes, busy) {
  return (classes || []).map(item => {
    const sessions = sessionsOf(item);
    const clashes = [];

    for (const ses of sessions) {
      if (ses.index === undefined || !ses.slot) continue;
      const hit = busy.get(KEY(ses.index, ses.slot));
      if (hit) clashes.push({ ...hit, dayIndex: ses.index, slot: ses.slot });
    }

    return {
      ...item,
      sessionCount: sessions.length,
      clashes,
      // An unreadable schedule is NOT a conclusion of "no clash" — not knowing
      // is entirely different from knowing it is safe. Flag it separately so it
      // ranks below.
      unknownSchedule: sessions.length === 0
    };
  });
}

/**
 * Ranking: feasible first, then roomiest.
 *
 * The priority order is deliberate:
 *   1. no clash          — a clash means you cannot attend, room or not
 *   2. schedule readable — an unknown schedule is not something to recommend
 *   3. low headcount     — a roomier class is easier to hunt into
 *   4. headcount known   — unknown headcounts sink within an otherwise tied group
 */
export function rankCandidates(evaluated) {
  return [...evaluated].sort((a, b) => {
    const clashA = a.clashes.length > 0;
    const clashB = b.clashes.length > 0;
    if (clashA !== clashB) return clashA ? 1 : -1;

    if (a.unknownSchedule !== b.unknownSchedule) return a.unknownSchedule ? 1 : -1;

    const hasA = a.count !== null && a.count !== undefined;
    const hasB = b.count !== null && b.count !== undefined;
    if (hasA !== hasB) return hasA ? -1 : 1;
    if (hasA && hasB) return a.count - b.count;

    return String(a.className).localeCompare(String(b.className));
  });
}

/**
 * A short reason for one class, so the user does not have to take the ranking
 * on faith.
 *
 * @param {object} cand a scored class
 * @param {string[]} weekdays weekday labels (T2…CN)
 */
export function describeReason(cand, weekdays) {
  const parts = [];

  if (cand.clashes.length) {
    const list = cand.clashes
      .map(x => `${x.subjectCode || x.className} ${weekdays[x.dayIndex] || '?'} slot ${x.slot}`)
      .join(', ');
    parts.push(`trùng giờ ${list}`);
  } else if (cand.unknownSchedule) {
    parts.push('chưa đọc được lịch');
  } else {
    parts.push('không trùng môn nào');
  }

  if (cand.count !== null && cand.count !== undefined) parts.push(`${cand.count} sv`);
  else parts.push('chưa rõ sĩ số');

  return parts.join(' · ');
}

/**
 * Summary for the single line printed above the grid.
 */
export function summarizeAdvice(ranked) {
  const ok = ranked.filter(x => !x.clashes.length && !x.unknownSchedule);
  const clash = ranked.filter(x => x.clashes.length);
  return {
    total: ranked.length,
    feasible: ok.length,
    clashing: clash.length,
    best: ok.length ? ok[0] : null
  };
}
