/**
 * THE CACHE — one single place declaring what is remembered, for how long, and why.
 *
 * Each feature used to cache in its own way, scattered across app.js. The
 * damage was not ugly code: it made "how old is the number I am looking at?"
 * UNANSWERABLE without reading three separate places. For a tool whose whole
 * job is deciding on fresh data, that is the most important question there is.
 *
 * The retentions differ because the RATE OF CHANGE differs, not for convenience:
 *
 *   courses   — enrolled subjects: change when YOU move class -> dropped then
 *   att       — schedules of enrolled subjects: same
 *   sched:*   — schedules of open classes: unchanged for the whole term
 *   deptMap   — subject code -> department: unchanged for the whole term
 *   size:*    — headcounts: change BECAUSE OF OTHER PEOPLE, by the minute
 *               -> short retention, always re-read
 *
 * The first three change because of the user's own actions, so we know exactly
 * when to drop them. The last one we can never know about, so it is never
 * trusted.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const TTL = {
  courses: 12 * HOUR,
  att: 12 * HOUR,
  sched: 7 * DAY,
  deptMap: 120 * DAY,
  size: 30 * MIN
};

/**
 * Every DATA key the tool has ever written — used by the Reload button.
 *
 * Deliberately does NOT include 'settings': Reload is for wiping data you
 * suspect is wrong, not for resetting the user's choices. Wiping settings too
 * would mean re-enabling everything they picked after every press.
 */
const PREFIXES = ['courses', 'att', 'sched', 'deptMap', 'size', 'deptBySubject'];

export async function get(key, ttl) {
  try {
    const box = await chrome.storage.local.get(key);
    const hit = box[key];
    if (!hit || typeof hit.at !== 'number') return null;
    if (ttl && Date.now() - hit.at > ttl) return null;
    return { data: hit.data, at: hit.at, age: Date.now() - hit.at };
  } catch (e) {
    return null;
  }
}

export async function set(key, data) {
  try {
    await chrome.storage.local.set({ [key]: { at: Date.now(), data } });
  } catch (e) {
    // Out of quota or a write error: ignore. A broken cache is not allowed to
    // break the whole session — at worst things get slower.
  }
}

export async function drop(...keys) {
  try {
    await chrome.storage.local.remove(keys);
  } catch (e) { /* as above */ }
}

/**
 * Cached read: return the copy if it is still fresh, otherwise call the fetcher
 * and store the result.
 *
 * `force` skips the cache but STILL writes back — which is what the "Reload"
 * button needs.
 */
export async function cached(key, ttl, fetcher, { force = false } = {}) {
  if (!force) {
    const hit = await get(key, ttl);
    if (hit) return { ...hit, fromCache: true };
  }
  const data = await fetcher();
  await set(key, data);
  return { data, at: Date.now(), age: 0, fromCache: false };
}

/** Wipe everything the tool has remembered. Leaves the user's settings alone. */
export async function clearAll() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(
      k => PREFIXES.some(p => k === p || k.startsWith(p + ':'))
    );
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  } catch (e) {
    return 0;
  }
}

/** List what is currently remembered, with ages — for showing the user */
export async function summary() {
  try {
    const all = await chrome.storage.local.get(null);
    const out = [];
    for (const [k, v] of Object.entries(all)) {
      if (!PREFIXES.some(p => k === p || k.startsWith(p + ':'))) continue;
      out.push({ key: k, age: v && typeof v.at === 'number' ? Date.now() - v.at : null });
    }
    return out;
  } catch (e) {
    return [];
  }
}
