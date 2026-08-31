# Auto Move Class — the extension build

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick the `extension/` folder
4. Sign in to the portal the way you normally do
5. Click the extension icon in the toolbar

## Architecture: why every request goes through a portal tab

The first version had the extension page call `fetch()` straight at the portal,
on the assumption that `host_permissions` was enough. **It isn't, and it broke
on the very first request:**

```
/Student.aspx  →  403
```

A request from `chrome-extension://…` is cross-origin and carries an
`Origin: chrome-extension://<id>` header, which the portal rejects outright.
`host_permissions` only settles the Chrome side of the question — whether the
request is served at all is decided on the server.

So the work is split:

| Where | Job | Why |
|---|---|---|
| extension tab (`app.js`) | UI + the hunting loop | stays alive for hours |
| content script (`content.js`) | **the network calls** | runs inside the portal page, so its requests are same-origin |
| `bridge.js` | joins the two | finds or opens a portal tab, rebuilds it when the tab closes |

A content script fetching the portal from inside a portal page sends no `Origin`
header, sends the correct `Referer`, and `Sec-Fetch-Site: same-origin` — the
normal shape of a request the page itself would make.

The extension this one borrows from (Pear104) never hit this, because it runs
**entirely** inside a content script. The price it pays is losing all state on
every page navigation.

## Why this is so much simpler than the CLI build

The CLI build drives a separate Chrome from the outside, so it has to do
everything itself: launch Chrome with the right flags, attach to CDP, sign in
to SSO, store the password with DPAPI, keep the session from expiring, hide the
window.

The extension runs *inside* the user's own browser. With `host_permissions`,
`fetch()` attaches the portal session cookie by itself — and that session is the
one they are already using. All of the above simply goes away.

## Why the tool opens in a TAB, not a popup

A slot hunt can run for hours.

- a **popup** dies the moment you click anywhere else
- an MV3 **service worker** is stopped by Chrome after ~30 seconds idle
- a **tab** lives exactly as long as the tab does

So `background.js` does one thing only: open the tab. Everything heavy lives in
`app.js`.

The content script only carries network calls for the app page — it is torn down
on every navigation, and the portal posts back constantly, so nothing important
is kept there.

## Cache boundaries

| Data | Cached | Reason |
|---|---|---|
| Schedule of open classes | 7 days | unchanged for the whole term |
| "subject → department" table | whole term | department numbers are fixed |
| **Class headcount** | **never** | changes by the minute, and it is the number the decision rests on |

A cached schedule is only usable if it covers **every** class in the dropdown —
the school opening extra classes mid-term is routine, and a newly opened class
is exactly the one worth looking at.

Dropdown `value`s **always** come from the page just loaded, never from cache:
reusing an old value after the portal renumbers its options moves you into the
wrong class.

## Traps ported over verbatim

- **`lblNewSlot` keeps its original string.** "Tidying up" the string deletes the
  comma separating two sessions, leaving every class with one session per week.
- **The attendance table is found by content, not by `#divDetail`.** The portal
  puts a `<div>` directly inside a `<tr>`; the browser foster-parents it out of
  the table and leaves an empty div behind.
- **Headcounts scan every matching row, not just the first.** The first matching
  row can be a header row with no class link in it.
- **A headcount is only accepted in the exact `| 28-(` shape.** Grabbing "any
  nearby number" pulls 170 out of the class name SE1705.
- **Headcounts are collected from every department.** Soft-skill subjects name
  their classes after the major, so they are spread across many departments.

## Not built yet

- Class roster with photos (`getRoster` is written, not wired to the UI)
- HTML export of the class list
- Discord/Telegram notifications
