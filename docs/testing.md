# Testing

## Unit and DOM tests

```sh
npm run check   # tests, TypeScript, and the dev build
```

Or run the pieces separately with `npm test`, `npm run typecheck`, and `npm run build`. CI runs `npm run check` and `npm run release` on every push to `main` and every pull request.

The Node tests (`tests/*.test.ts`, run with `node --test`) cover recorder state, ordered persistence, capture safety, errors, legacy data, deletion, revision ordering, panel controls, text entry, scroll following, quota fallback, exports, the guide editor and library, Guide me, settings, and automatic blur. Each file is named after the module or behavior it tests.

Browser APIs are explicit in-memory adapters (`src/chrome-port.ts`). DOM tests use jsdom and replace only the trusted-event boundary when exercising ordinary entry. They are not real Chrome permission evidence; the browser smoke test is.

## Browser smoke test

```sh
npx playwright install chromium   # once
npm run test:browser
```

`scripts/smoke.mjs` launches Playwright's Chromium headed with a fresh profile under ignored `.test-artifacts/`, loads the unmodified production extension from `dist/`, serves a localhost-only fixture, and invokes the real toolbar action through Chrome's experimental `Extensions.triggerAction` DevTools command. It attaches to the native side-panel target, not an extension page opened as a tab. It never uses a personal Chrome profile or broadens extension permissions, and it closes the browser and server and deletes the profile when it finishes.

On a machine without a display, run it under Xvfb:

```sh
xvfb-run -a npm run test:browser
```

What it checks:

- Native panel opening, live cards, trusted clicks with real JPEG images, preview, deletion, completion, the panel's HTML download, viewer markers, and confirmed discard/deletion with storage read-back.
- Real keyboard typing, clipboard paste, textarea and contenteditable entry, clearing, text typed immediately before Pause and Complete, secret and synthetic-input suppression, and review-aware following after scrolling up.
- The exact persisted action order, and that the newest screenshot card fits above the controls without scrolling or defocusing the recorded page.
- The guide editor on the real capture: autosaved title, description, instruction and note (shown live in the panel), an inserted tip, button and drag reordering, blur plus crop, a Word export with one image per screenshot, and the print page.
- Responsive layout at 320 and 450 CSS-pixel panel widths, the manifest and action name, and that the bundled Nunito font loads from the extension itself.

Evidence lands in `.test-artifacts/`: `smoke-result.json` (measured entry, step and image totals), panel and editor screenshots, `Smoke guide.docx`, and `smoke-sop.html`. Rapid entries may show rate-limit reasons instead of images, so image totals vary between runs.

The fixture grants clipboard access to test a real paste and hides dummy secret glyphs to keep those values out of screenshot evidence. Neither is an extension permission or extension redaction.

Limits: experimental CDP APIs may need adjusting for another Chromium version, and the smoke verifies the localhost fixture flow, not every website or the minimum supported Chrome version.

## Testing a release build

The smoke test runs on the dev build. To exercise the minified build that ships:

```sh
npm run release
node scripts/smoke.mjs
```

Older verification notes are kept in [archive/verification-log.md](archive/verification-log.md).
