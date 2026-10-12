# Privacy, scope and permissions

Stepnote is local only. Guides stay in `chrome.storage.local` on your device. Nothing is uploaded. There are no accounts, analytics, remote scripts or remote fonts, and no runtime dependencies on external services.

## What gets captured

Capture follows the top-level document of the tab in focus. Switching tabs, a link that opens a new tab or window, focusing another window, reloading, and navigating to a new page all move capture to that page. The previous page's listener is drained and removed, and the new page gets a fresh listener identity once it has finished loading. Same-document routes keep their existing listener.

Pages Stepnote cannot access (Chrome pages, the Web Store, or any page when web access was declined at Start) record nothing and show a notice until you return to a web page. Closing the followed tab does not end capture. Iframes are not captured.

Each step records the page title, URL origin and path, an action label, viewport dimensions, action position, and timestamps. Query strings, fragments, and URL credentials are omitted. Page text, titles, and URL paths can still contain private information. Type-step markers describe the field-center input position, not another click.

### Text entry

Trusted clicks stay separate from trusted ordinary entry in text, search, email, URL and telephone inputs, textareas, and contenteditable regions.

- The first actual input creates a live `Type "..."` card. Typing, replacement, paste, and deletion update that same card through idle gaps. Empty values show `Clear`.
- Blur, click-away, field changes, or plain Enter finalize the editing session. Same-field caret clicks do not split it. Shift+Enter continues multiline entry; IME Enter does not finalize partial composition. A new session starts only when actual input follows a completed boundary.
- Live entries show a pending-image hint. Only the final update requests a best-effort screenshot, never every keystroke.
- Synthetic events and programmatic changes alone create no steps. No raw keystroke sequence is recorded.
- Entry snapshots contain at most the first 2,000 UTF-16 code units of the resulting field value.

Ordinary entered text is guide content. It is included in saved guides and in exports. Free-text notes, searches, and pasted text may contain private information. Review labels as well as images before sharing.

### Excluded fields

Passwords, hidden and non-text inputs, and recognized credential, one-time-code and payment controls are excluded from entry values. Recognition uses type, autocomplete, name, and ID metadata, including username, password, token/API-key, verification-code, card number/holder/expiry, and card-security-code patterns.

Recognized secret controls receive only `Click protected field` labels. Other field clicks use labels, aria-label/aria-labelledby, or placeholders, never current values.

This is a metadata-based exclusion. It does not detect every sensitive field or arbitrary secrets typed into ordinary text.

## Automatic blur

**Blur private info automatically** (panel home, on by default, remembered on this device) pixelates private details before a screenshot is saved:

- recognized credential, one-time-code and payment fields;
- filled email and phone fields;
- visible text that looks like an email address, phone number, card number (Luhn-checked), US Social Security number or IBAN.

The scan includes open and closed shadow roots and same-origin frames, including scaled frames. A visible frame that cannot be read (cross-origin) or mapped (rotated, skewed, mirrored, 3D or on a motion path, on the frame or any parent) is blurred whole. The page reports these regions just before and just after the capture, and both sets are blurred.

If the page cannot be checked, or the screenshot does not match the page's viewport shape, the screenshot is not saved and the step shows why. Original pixels are never stored.

Detection is pattern-based and can miss names, addresses, account details in images, and anything else. Review every screenshot.

## Screenshots

Screenshots contain visible page content. They are best-effort post-action captures and may show a later page state. Dynamic layout changes can move the target away from its marker.

- The extension checks the followed document, active tab, and window before and after capture, and discards images when these checks fail. Clicks already received before a tab switch or navigation stay as steps, with a missing-image reason when necessary. A click that immediately opens a new tab usually has no image for this reason.
- Chrome does not offer an atomic document-bound screenshot API, so these checks cannot eliminate every possible tab-switch race. Avoid switching tabs during a capture.
- Screenshot API calls are at least 650 ms apart. Faster click and entry steps remain visible with a missing-image reason. Restricted pages or revoked permissions can also produce a missing-image reason.

## Capture reliability

- Pause, Complete, and moving to another page request an acknowledged drain from the followed document before their command finishes. Pending entry revisions are drained and listeners stop. Stable IDs and increasing sequences prevent duplicate, reordered, finalized, or deleted entries from returning.
- Resume installs a fresh listener identity, so old callbacks cannot splice paused or discarded entries into a new capture. If the original document cannot acknowledge finalization, the panel shows a warning rather than claiming final text was saved.
- A lightweight panel heartbeat keeps the worker available while the panel is open. Content-script heartbeats also run during recording. If Chrome restarts the worker, an active or paused capture stops for safety. Saved steps remain available.
- Closing the panel does not complete capture. Reopen it to pause or complete.

## Storage

The active guide and the guide library are kept in `chrome.storage.local`, restricted to trusted extension contexts. `unlimitedStorage` lifts Chrome's local size limit for the library; it grants no other access.

If a new click or finalized-entry image exceeds the storage quota, only that new image is omitted and metadata is retried once with a visible storage-quota reason. Previous images remain intact, and capture continues only if that write succeeds. A failed retry or other write failure stops recording and displays an error. Unexpected stops show `Stopped` and their reason rather than looking like explicit completion. The panel can still review and export unsaved steps; export promptly, because there is no durable recovery journal.

Recordings from earlier versions remain readable. Stable step IDs are added locally without changing their labels, screenshots, or order.

Deleting a guide does not delete files you already exported.

## Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporary access to the page you invoke the extension on, including screenshot capture. |
| `scripting` | Inject capture listeners into the followed top-level document and verify its identity. |
| `<all_urls>` (optional) | Requested when you choose **Allow and start** after **Start Capture**, so capture and screenshots can follow new tabs, page loads, and other windows. Chrome's screenshot API accepts only `<all_urls>` or `activeTab`, so narrower `http`/`https` access is not enough. Declining limits capture to the starting page. You can revoke it from the extension's details page. |
| `storage` | Keep guides locally. |
| `favicon` | Read the site icon Chrome already has cached for a page, to label guides with it. Served by Chrome locally; nothing is fetched from the website. |
| `unlimitedStorage` | Let the local guide library grow past Chrome's default storage limit. Local only. |
| `sidePanel` | Display the persistent native Chrome side panel. |

There are no install-time host permissions and no `tabs` permission. `<all_urls>` is only granted if you accept the prompt at Start. Chrome internal pages, the Web Store, and some browser-managed documents cannot be recorded.

Invoke the actual toolbar action on the target page. Opening `sidepanel.html` as an ordinary tab, or changing the selected tab in an already-open panel, does not grant `activeTab`. Start resolves the active web tab in the panel's own window, and the worker checks its identity again.
