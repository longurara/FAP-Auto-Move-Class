<div align="center">

<img src="icons/icon128.png" width="96" alt="Auto Move Class logo">

# FAP Auto Move Class

**See which class still has room, which one collides with your timetable,
and take the seat the moment it opens.**

A Chrome extension for **FAP**, the FPT University student portal.
No server, no account, no password — it reuses the session already sitting in
your browser.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-install-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/fap-auto-move-class/ghigbogpfhpgcogmbjehjpfigpgcalof)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-2ea44f)
![Backend](https://img.shields.io/badge/backend-none-2ea44f)
![Tracking](https://img.shields.io/badge/tracking-none-2ea44f)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

<div align="center">

<img src="docs/screenshot-timetable.png" width="880" alt="Timetable view: open classes on a week grid, coloured by headcount, with clashes struck through">

<sub>**The timetable view.** All 26 open classes of one subject on a real week grid.
Each cell is filled in proportion to how full the class is; your current class is
marked ★; hatched, struck-through cells collide with another subject and say
which one. The banner on top names the best feasible candidate and offers to hunt
it.</sub>

<br><br>

<img src="docs/screenshot-confirm.png" width="880" alt="Confirmation dialog showing the class being left, the class being joined, and its headcount">

<sub>**Confirming a move.** It spells out which class you are leaving and which you
are joining, with the target's headcount and how long ago that number was read —
here 36 of 36, the fullest class of the subject. Focus starts on Cancel, so a
stray Enter does nothing.</sub>

</div>

---

## What it does

Moving class on FAP means opening a dropdown, picking a class blind, and pressing
Save into a wall of "class is full". This turns that into one screen.

|  | |
|---|---|
| **Headcounts at a glance** | Every open class, coloured by how full it is relative to the fullest one. The number is never cached for long — it changes by the minute, and it is the number the decision rests on. |
| **Clash detection** | Reads the schedule of *every* subject you are enrolled in and strikes out any class that collides. A clash is a hard constraint: it does not matter how much room a class has if you cannot attend it. |
| **Timetable view** | Open classes laid out on a real week grid, your current class marked ★, so you can see what the swap actually does to your week. |
| **Slot hunting** | Pick a class and the tool presses Save on a loop until a seat frees up. It backs off when FAP is congested, says what it is waiting on, and stops the moment you tell it to. |
| **Recommendation** | Ranks the candidates — feasible first, then roomiest — and says *why*, so you are not asked to trust a number you cannot check. |

It deliberately **does not move you automatically**. It ranks and explains; the
decision stays yours, because it knows nothing about the constraints that are not
on the timetable — a job, friends in a class, a particular lecturer.

## Install

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/fap-auto-move-class/ghigbogpfhpgcogmbjehjpfigpgcalof)** — one click, and Chrome
keeps it updated.

<details>
<summary>Or load this folder unpacked</summary>

Useful if you want to read the source you are running, or try a change before it
reaches the store.

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder

</details>

Then:

1. Sign in to FAP the way you normally do
2. Click the extension icon in the toolbar

Requires Chrome 116 or newer.

## How it works

```mermaid
flowchart LR
    A["Extension tab — app.js<br/>UI + hunting loop"]
    B["bridge.js<br/>finds or opens a FAP tab"]
    C["Content script — content.js<br/>inside the FAP page"]
    D[("fap.fpt.edu.vn")]

    A -->|message| B
    B -->|sendMessage| C
    C -->|same-origin fetch| D
    D -.->|HTML| C
    C -.->|reply| A
```

**Why the network calls do not happen in the extension page.** The first version
called `fetch()` straight at FAP, assuming `host_permissions` was enough. It
isn't, and it broke on the very first request with a `403`. A request from
`chrome-extension://…` is cross-origin and carries an
`Origin: chrome-extension://<id>` header, which FAP rejects outright.
`host_permissions` only settles the Chrome side of the question — whether the
request is served at all is decided on the server.

A content script running *inside* the FAP page sends no `Origin` header, the
correct `Referer`, and `Sec-Fetch-Site: same-origin`, so its requests go through
normally. Hence the split: the UI lives in a long-lived extension tab, and every
network call is relayed through a FAP tab.

**Why a tab and not a popup.** A hunt can run for hours. A popup dies the moment
you click elsewhere, and an MV3 service worker is stopped by Chrome after ~30
seconds idle. A tab lives exactly as long as the tab does, so `background.js`
does one thing only — open the tab — and everything heavy lives in `app.js`.

### Layout

| File | Job |
|---|---|
| `app.js` | UI, load orchestration, the hunting loop |
| `background.js` | opens the tool's tab, nothing else |
| `content.js` | makes the network calls from inside the FAP page |
| `src/bridge.js` | finds or opens a FAP tab, rebuilds it when closed |
| `src/fap.js` | the FAP call layer: retries, backoff, error classification |
| `src/parse.js` | HTML parsers, and the traps that come with them |
| `src/advisor.js` | clash detection and candidate ranking |
| `src/store.js` | one place declaring what is cached, for how long, and why |

## Cache boundaries

Retentions differ because the **rate of change** differs, not for convenience:

| Data | Cached | Why |
|---|---|---|
| Schedule of open classes | 7 days | unchanged for the whole term |
| Subject → department table | whole term | department numbers are fixed |
| Your enrolled subjects | 12 hours | changes when *you* move class — dropped at that moment |
| Your attendance schedule | 12 hours | same |
| **Class headcount** | **30 minutes, always re-read** | changes because of *other people*, by the minute |

Two rules that are easy to get wrong:

- A cached schedule is only usable if it covers **every** class in the dropdown.
  The school opening extra classes mid-term is routine, and a newly opened class
  is exactly the one worth looking at.
- Dropdown `value`s **always** come from the page just loaded, never from cache.
  Reusing an old value after FAP renumbers its options moves you into the wrong
  class — a real failure, not a display glitch.

## Privacy

No server. Nothing is sent to the developer or to any third party. The extension
talks to exactly one host — `https://fap.fpt.edu.vn` — using the login session
already in your browser, and everything it remembers lives in
`chrome.storage.local` on your machine.

It never sees your password: there is no password field, FAP's login page is
never embedded in the UI, and nothing you type is read. When you are signed out
it opens a real tab at FAP's own login page — address bar and padlock intact —
and simply asks FAP when you are done.

Class rosters are **never stored**; names and photos are drawn on screen and gone
when you close the tab. FAP only exposes the roster of a class you are enrolled
in, and the code deliberately refuses arbitrary group ids so URL enumeration is
not possible.

Full detail in **[PRIVACY.md](PRIVACY.md)**.

## Engineering notes

Traps found the hard way, kept as comments in the source:

- **`lblNewSlot` keeps its original string.** "Tidying" it deletes the comma
  separating two sessions, leaving every class with one session per week.
- **The attendance table is found by content, not by `#divDetail`.** FAP puts a
  `<div>` directly inside a `<tr>`; the browser foster-parents it out of the
  table and leaves an empty div behind. Selecting by id gets you the shell, no
  rows, and it all looks like an empty page despite an HTTP 200.
- **Headcounts scan every matching row.** The first match can be a header row
  with no class link in it — taking only the first row once produced "0 results"
  across all 17 departments while the data sat right there.
- **A headcount is only accepted in the exact `| 28-(` shape.** Matching "any
  nearby number" pulls `170` out of the class name `SE1705` — plausible enough
  that nobody questions it, and wrong enough to send you hunting a full class.
- **Headcounts are collected from every department.** Soft-skill subjects name
  their classes after the major, so they are spread across many departments.
- **The subject on the returned page is cross-checked against the one requested.**
  Without it, FAP can hand back a different subject's page while the heading
  still shows what you clicked — which once meant clicking `WDU203c` and getting
  the 29 classes of `SSG105`.
- **The move-class control is not a link.** It is an ASP.NET `LinkButton`, so
  `MoveSubject.aspx` does not exist until its `__doPostBack` target is POSTed.

## Roadmap

- [ ] Class roster with photos wired into the UI (`getRoster` is written)
- [ ] HTML export of the class list
- [ ] Discord / Telegram notifications when a seat opens

## A note on use

The hunting loop presses Save repeatedly against a server that is already busiest
exactly when you want to use it. It backs off on congestion (1.5s → 20s), caps
concurrency, and stops when told to — please leave those limits alone, and stop
the hunt when you no longer need it.

This project is not affiliated with, endorsed by, or connected to FPT University.

## License

[MIT](LICENSE) © longurara
