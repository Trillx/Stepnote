# Stepnote verification log (archived)

> Historical record of manual and browser verification runs during early development. It is not kept up to date. Paths under `.scratch/` and `.test-artifacts/` point to local, uncommitted evidence. For how to test the extension today, see [testing.md](../testing.md).

## Current live-entry, following, and continuity checks

- `npm run check`: 79 tests passed, TypeScript passed, and the unpacked extension built successfully.
- `npm run test:browser`: passed in headed isolated Chromium 153.0.8010.12 with the exact production manifest and unchanged permissions. The native panel retained 17 steps, including six finalized text-entry sessions and seven real images. The first focused Type card appeared in 128 ms, before the previous 400 ms idle boundary.
- `FIXED=1 node .scratch/capture-continuity/probe.mjs`: passed against a fresh current-source snapshot. Same-document pushState on the second trusted click retained the document token and admitted the third and fourth clicks. Actual reload changed the token and stopped capture. Four high-entropy 3400x2400 screenshot actions continued with the first image retained and later image-quota failures saved as explicit missing-image reasons. Pause/Resume stayed responsive. A real keyboard entry then finalized in the same identity, omitted its quota-exceeding final image, and remained recording.
- `git diff --check`: passed. Git emitted only Windows LF/CRLF conversion warnings.

The native smoke verifies the Stepnote action/manifest title, the locally bundled Nunito face loading from the extension origin, the compact home, real keyboard input and clipboard paste, same mounted live card across idle and correction, Enter finalization and its final thumbnail, latest exported labels, immediate Pause/Complete drains, secret/synthetic/paused suppression, preview/delete/export, and storage deletion read-back. Default following reveals new cards, but hover and upward review stay put even when images load. Returning to bottom and leaving resumes following. Host-page scroll and typing focus stay unchanged. The 320/450-pixel panel checks include the polished stylesheet and font.

Test-first failures were observed for absent immediate live cards, blocked-screenshot latest updates, hover/upward-review scrolling, wheel and keyboard review before scroll events settle, accepted Enter finals losing their screenshot when Pause closed admission, new-image quota ending capture, same-document URL updates ending capture, Chromium's combined loading+URL pushState signal, and unexpected stops labeled Complete. Each implementation slice passed its targeted check before the final full-suite run. Prior idle-burst tests were explicitly changed to assert live draft revisions and final boundaries, rather than weakening their action-order, privacy, and screenshot assertions. Additional regressions cover final-first/out-of-order delivery, deleted live entries, old acknowledgements, current previews/exports, bounded labels, and stale document checks after Resume/Delete/Start.

Chromium emits `tabs.onUpdated` loading plus URL changes even for pushState. The worker therefore validates original document/window authority on URL changes and rechecks on completion. Loading without a URL still stops immediately. Route verification may inspect identity during loading, but screenshot pre/post checks still require a complete active tab in the original window. No new document is injected or admitted, no host permissions were added, and failed identity validation stops with an honest reason.

Only confirmed quota errors on a newly captured click/final-entry image trigger a single metadata retry. Prior images are untouched. Failed retries restore the unsaved new image for immediate export and stop safely; generic write errors are not retried. These reproduced mechanisms are not proof of the user's specific intermittent-stop cause.

Current evidence: `.scratch/live-text-entry/results.json`, `.test-artifacts/live-check.log`, `.test-artifacts/live-browser.log`, `.test-artifacts/smoke-result.json`, `.test-artifacts/sidepanel-home.png`, `.test-artifacts/sidepanel-text-entry.png`, `.test-artifacts/sidepanel-text-final.png`, `.test-artifacts/sidepanel-review.png`, responsive panel images, viewer image, and downloaded `smoke-sop.html`. Continuity evidence and exact source hashes are separate in `.scratch/capture-continuity/fixed-evidence/`, including `browser-evidence.json` and `quota-panel.png`. Baseline and scratch-candidate artifacts were preserved. `dist/` is the loadable unpacked build. All profiles and servers were cleaned up. No personal profile was used, and nothing was committed or pushed.

## Historical native side-panel and idle-burst verification

The sections below preserve earlier evidence. Their forced-follow and idle-burst behavior is superseded by the current checks above.


## Checks

- `npm run check`: 59 tests passed, TypeScript passed, and extension build passed.
- `npm run test:browser`: passed in isolated Chromium 153.0.8010.12 with the production manifest and permissions unchanged.
- `git diff --check`: passed.

The headed smoke loads the exact shipped manifest, invokes `Extensions.triggerAction`, and attaches to the native `sidepanel.html` target. It verifies the original click/preview/delete/export flow and the new ordinary-entry flow through real keyboard typing, clipboard paste, textarea/contenteditable input, clearing, and typing immediately before Pause and Complete. It asserts the exact order of 17 retained steps, including six entry steps. The latest recorded run retained seven real JPEG images; rapid steps without images have explicit reasons. Image totals can vary with the screenshot rate limit.

After deliberately scrolling the panel upward, a new field-click card with a real image must appear entirely within the list, above the fixed controls. The recorded page must keep its scroll position and input focus. The smoke checks loaded thumbnail geometry, live Type cards, paused input suppression, recognized password/one-time-code/payment exclusion, synthetic-input suppression, final entry persistence, viewer labels, exported ordinary text, and deletion read-back. Layout checks also cover no horizontal overflow or footer overlap at emulated widths of 320 and 450 CSS pixels.

Generated evidence lives in ignored `.test-artifacts/`: `check.log`, `browser.log`, `smoke-result.json`, `sidepanel-home.png`, `sidepanel-live.png`, `sidepanel-text-entry.png`, `sidepanel-preview.png`, `sidepanel-review.png`, `sidepanel-320.png`, `sidepanel-450.png`, `viewer.png`, `recorded-procedure.html`, and `smoke-sop.html`. `dist/` is the loadable unpacked build. The browser and localhost server close and the profile is removed in `finally`. No personal profile or account data is used. The production permissions and host grants are unchanged. A localhost-only browser-context clipboard grant enables an actual paste; it is not an extension permission. The fixture masks dummy secret glyphs to avoid putting their values in screenshot evidence. This is fixture styling, not extension redaction.

## Text-entry test-first slices

Vertical red/green commands used during this change included:

```sh
node --test --test-name-pattern='every new identity' tests/sidepanel.test.ts
node --test tests/page-click.test.ts
node --test tests/text-entry.test.ts
node --test --test-name-pattern=IME tests/text-entry.test.ts
node --test --test-name-pattern='Pause and Complete' tests/text-entry.test.ts
node --test --test-name-pattern='delayed finalization' tests/text-entry.test.ts
node --test --test-name-pattern='input validates' tests/recorder.test.ts
node --test tests/sop.test.ts
node --test --test-name-pattern='recognized payment' tests/page-click.test.ts
node --test --test-name-pattern='a trusted ordinary' tests/text-entry.test.ts
node --test --test-name-pattern='late earlier' tests/sidepanel.test.ts
node --test --test-name-pattern='late text' tests/recorder.test.ts
node --test --test-name-pattern='listener injection' tests/text-entry.test.ts
npm run check
npm run test:browser
git diff --check
```

Observed failures covered missing forced scroll, generic instead of accessible field names, the missing page-capture entry path, absent blur finalization, prematurely published IME text, missing final text at Pause/Complete, post-pause input leaking into a delayed drain, invalid entry labels being admitted, click-position wording for type steps, unrecognized payment names, misleading click-only rate-limit wording, late earlier images failing to reveal the newest card, and old listener text entering a new capture in the same document. Each corresponding implementation slice passed its targeted test and the full check afterward. Additional tests verify sender rejection, pre-value secret exclusion, action deduplication after deletion, acknowledged document targeting, drain failure warnings, and a controlled pending-screenshot/INPUT/control interleaving without deadlock.

Pause/Complete close normal admission immediately. The content listener returns pending and unacknowledged entry payloads directly in its document-bound finalization acknowledgement. It does not wait for INPUT responses that may themselves await the worker's control queue. Entry identities prevent duplication or deletion resurrection, and per-arm capture identities reject callbacks from discarded or pre-pause listeners. Identity initialization and content-script injection use the same original document ID, rather than potentially crossing navigation between those two calls. A regression failed with frame-only injection before that fix. Finalization filters out input newer than the control cutoff. Navigation, original-window checks, queued-click retention, worker revision ordering, and the reviewed pause/resume and badge protections remain tested.

The real browser test exposed two layout/test issues. Smooth scrolling made the smoke helper click coordinates stale while it tried to reach an earlier preview. Explicit test-control scrolling now settles immediately before CDP mouse input. Scrolling to total list height also hid the newest heading above the viewport because scope/privacy text follows the cards. The production reveal now uses the newest card's bounds in its own scroll container. Cards that fit remain above the footer; taller cards reveal their heading. Thumbnail loads recheck the latest card without focusing it or scrolling the recorded page.

One intermediate full-suite run timed out because the old badge test double did not acknowledge the newly added finalization message, causing a warning badge rather than its expected stopped badge barrier. The adapter double now models that acknowledgement. The subsequent full suite and actual Chromium smoke pass. No current independent review is claimed by this implementation report; the sections below record the prior side-panel and starter reviews.

## Test-first side-panel slices

Each new behavior was exercised through a failing test before implementation. Targeted commands used during the red/green cycles included:

```sh
node --test --test-name-pattern='pause suppresses' tests/recorder.test.ts
node --test --test-name-pattern='step deletion' tests/recorder.test.ts
node --test tests/panel-flow.test.ts
node --test --test-name-pattern='notifications|starter recordings' tests/recorder.test.ts
node --test tests/sidepanel.test.ts
node --test --test-name-pattern=heartbeat tests/panel-flow.test.ts
node --test --test-name-pattern='admission immediately|panel shows' tests/recorder.test.ts tests/sidepanel.test.ts
node --test tests/viewer.test.ts
```

The added tests cover paused click suppression, original document/window validation before and after resume, listener reinjection, stable IDs and repeated stale deletion requests, preservation and migration of starter recordings, worker notifications containing unsaved state, lightweight heartbeats without image reads, safe live card display, scaled markers, preview auto-pause, explicit resume, completion/export, and confirmed deletion. Existing capture-window and queued-click protections remain tested. A pending-screenshot regression showed that a serialized pause initially admitted later clicks. Pause now closes admission immediately while preserving already-accepted steps.

The real browser opening test initially failed because the native panel was not wired up. Subsequent early invocations missed the worker's action listener during initialization. The smoke now waits for worker readiness, and the action handler calls `chrome.sidePanel.open({ windowId: tab.windowId })` synchronously within the action gesture. Node browser-API tests use explicit doubles; they are not proof of real permissions. The isolated smoke is the real-extension evidence. Minimum Chrome 120 and arbitrary websites were not separately tested.

## Side-panel review

### Standards

The independent review found no documented-standard violations or material code smells. The existing repository conventions remain unchanged.

### Spec and correctness

The review reproduced three timing defects with controlled in-memory adapters. Parent regression tests reproduced each failure before its fix:

1. An old stopped-state badge update could send DISARM after a new listener had been injected into the same document. Cosmetic badge updates no longer send teardown messages. The recorder rejects inactive clicks, and listeners clean up on their next inactive reply.
2. Pause arriving while Resume awaited document checks could be lost. Pause now reapplies its state in the serialized operation and increments a sequence that prevents an in-flight Resume from reopening click admission.
3. A delayed command response could replace newer live cards and export data. Worker snapshots now carry increasing revisions; the panel rejects older snapshots across both notification and response paths. Tests also check that change notifications and command snapshots use the same revision.

All three regressions pass. Parent reran the complete 39-test suite, typecheck, build, and native-panel browser smoke after the fixes. Standards: zero findings. Spec: three findings, all fixed and regression-tested.

## Prior starter review

The independent review of `ef4d780` against the initial setup commit `5b4010a` found no documented-standard violations or material code smells. The repository's issue-tracker and domain-document conventions were preserved.

### Capture-safety fixes preserved

The independent review found two correctness defects against the capture-safety and click-retention criteria in `.scratch/sop-recorder/spec.md`:

1. Moving the recorded tab between windows left capture targeting the original window. Fixed by checking the recorded tab's window identity before and after capture. The regression test exercises the actual Chrome adapter with browser API test doubles and checks both pre-capture and mid-capture moves.
2. Navigation discarded already-received clicks waiting behind an earlier screenshot. Fixed by validating and admitting clicks when received, then retaining accepted queued steps with a missing-image reason if recording ends before capture. A controlled pending-capture regression proves that both steps survive and later clicks remain ignored.

Both regression tests failed before their fixes and passed afterward. The full unit, typecheck, build, and real-browser smoke checks passed after both fixes.

That prior review reported zero standards findings and two spec findings, both fixed and regression-tested. It is historical evidence for the starter, not an independent review of this side-panel change.

## Shipped limits

One local recording at a time. Capture follows the top-level document of the tab in focus across tab switches, new tabs, windows, and full navigations, provided the optional web access requested at Start was granted; otherwise only the starting page is captured. Resume arms the page in focus; worker restart stops active and paused sessions for safety. Closing the panel does not complete capture. Event-driven UI updates include unsaved memory, but a worker restart can still lose unsaved steps after storage failure. Export immediately after a storage error.

Screenshots can contain visible sensitive information. This is image review, not redaction. There is no document library/search, voice, blur, desktop-app capture, continuous navigation workflow, cloud storage, or iframe/cross-tab capture. Step deletion is implemented; other step editing is not. Read `README.md` before capturing or sharing a procedure.

## Following the focused tab

Capture previously stopped on reload or document replacement and ignored new tabs. It now follows `tabs.onActivated`, `windows.onFocusChanged`, and completed loads of the followed tab. `tests/tab-follow.test.ts` covers new tabs that load after activation, returning to an earlier tab with a fresh capture identity, full navigation and reload without reinjecting an unchanged document, uncapturable pages showing a notice, ignored updates from unfollowed tabs, paused following with Resume arming the focused page, and closing the followed tab. `tests/background.test.ts` covers the same rules through the real worker event wiring. Not yet verified in a real browser by `npm run test:browser`; the smoke script does not exercise new tabs.
