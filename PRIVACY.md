# Privacy Policy — FAP Auto Move Class

Last updated: 2026-08-30

## Summary

This extension **has no server**. All data stays inside your browser. Nothing is
sent to the developer or to any third party.

The extension talks to exactly one host — `https://fap.fpt.edu.vn`, the FPT
University student portal (FAP), and the only host declared in the extension's
manifest — using the login session you already have in your browser.

## What the extension reads

From FAP, while you have the extension open:

| Data | What it is used for |
|---|---|
| The subjects and classes you are enrolled in | shown in the left rail, used as the baseline for comparison |
| Schedules of the open classes | to draw the timetable |
| Headcount of each class | to show which classes still have room |
| Your attendance schedule | to know which sessions your current classes use, and to detect clashes |
| The roster of a class you are enrolled in | only when you click "Class roster" yourself |

FAP only allows viewing the roster of a class **you are enrolled in**.
The extension has no way — and makes no attempt — to view any other class.

## What the extension stores

Stored with `chrome.storage.local`, meaning **on your machine only**:

| Item | Retention |
|---|---|
| Your enrolled subjects | 12 hours |
| Your attendance schedule | 12 hours |
| Schedules of open classes | 7 days |
| "subject code → department" table | whole term |
| Class headcounts | 30 minutes |
| The clash-detection on/off setting | until you change it |

**Not stored**: passwords, session cookies, and **class rosters** — your
classmates' names, IDs, and photos are only drawn on screen and are gone when
you close the tab.

The **Reload everything** button in the extension wipes everything stored.
Uninstalling the extension also removes it all.

## Passwords

The extension **never sees your password**. It has no password field, it does
not embed FAP's login page inside its own UI, and it does not read what you
type.

When you are not signed in, the extension opens a tab pointing at FAP's real
login page so you sign in there — with the address bar and padlock present so
you can verify where you are. The extension only asks FAP whether you are signed
in yet, so it knows when to continue.

## Permissions requested, and why

| Permission | Why it is needed |
|---|---|
| `storage` | to hold the cache described above, so FAP isn't re-queried on every open |
| `tabs` | to find or open a FAP tab and send requests through it |
| `https://fap.fpt.edu.vn/*` | the only address the extension is allowed to reach |

Requests are routed through a FAP tab rather than sent directly, because requests
issued from an extension page are rejected by FAP.

## What there isn't

No ads. No analytics, no metrics, no tracking. No selling or sharing of data —
there is no data leaving your machine to share in the first place.

## Contact

Problems or questions: open an issue on the project's source repository.

This project is not affiliated with, endorsed by, or connected to FPT
University. The source is available under the MIT licence.
