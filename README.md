# Stepnote

A local-only Chrome extension for writing step-by-step guides. Click and type through a procedure in any web page; Stepnote records each step with a screenshot in a native side panel. Edit the result, then export it as Word, PDF or HTML, or have Stepnote walk someone through it on the live site with **Guide me**.

Everything stays on your device. There is no backend, account, analytics, or remote code.

- [Using Stepnote](docs/usage.md): capturing, editing, exporting, your guide library, Guide me, settings.
- [Privacy, scope and permissions](docs/privacy.md): what is recorded, what is excluded or blurred, and why each permission is needed.
- [Testing](docs/testing.md): unit tests and the real-browser smoke test.

## Install

Stepnote needs Chrome 120 or newer.

1. Download `stepnote-<version>.zip` from the [latest release](https://github.com/Trillx/Stepnote/releases/latest) and unzip it.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder.
4. Pin **Stepnote** to the toolbar, open a web page, and click its button (or press `Ctrl+Shift+Y`).

## Develop

Use Node.js 22.18 or newer and npm.

```sh
npm ci
npm run check   # tests, TypeScript, and a dev build in dist/
```

Load `dist/` with **Load unpacked** as above. Do not load the repository root. After source changes, run `npm run build`, reload the extension in `chrome://extensions`, and refresh the page you intend to record.

| Command | What it does |
| --- | --- |
| `npm test` | Node unit and DOM tests (`tests/*.test.ts`). |
| `npm run typecheck` | TypeScript, no emit. |
| `npm run build` | Dev build in `dist/`, with source maps. |
| `npm run check` | All three of the above. CI runs this on every push and pull request. |
| `npm run test:browser` | Builds, then runs the real-extension smoke test in Playwright's Chromium. See [testing.md](docs/testing.md). |
| `npm run release` | Minified build without source maps, zipped to `release/stepnote-<version>.zip`. |

## Release

`package.json` holds the version. `npm version` copies it into `public/manifest.json`, commits both, and tags the commit:

```sh
npm version patch          # or minor, major, or an exact version such as 1.2.0
git push --follow-tags
```

Pushing a `v*` tag runs the release workflow. It checks that the tag matches `package.json`, runs `npm run check`, builds the zip with `npm run release`, and publishes a GitHub release with the zip attached. That zip is also the file to upload to the Chrome Web Store.

Chrome only accepts versions made of one to four dot-separated numbers, so pre-release versions like `1.0.0-beta.1` are rejected. The build fails if `package.json` and the manifest disagree.

## Source layout

- `public/`: manifest, HTML entry points, CSS, icons, and the bundled Nunito font.
- `scripts/`: `build.mjs` (esbuild bundle), `package.mjs` (release zip), `sync-version.mjs`, `smoke.mjs` (browser smoke test), `icons.mjs`.
- `tests/`: deterministic unit and DOM tests, one file per module or behavior.

In `src/`:

| Area | Modules |
| --- | --- |
| Worker | `background.ts` (wiring), `messages.ts` (trusted message routing), `recorder.ts` (recording state, persistence, capture safety checks), `tidy.ts` (Tidy up steps on completion), `chrome-port.ts` (Chrome API adapter), `badge.ts`, `route.ts` |
| Storage | `library.ts` (guide library), `settings.ts` |
| Page capture | `content.ts`, `page-capture.ts`, `page-click.ts`, `fields.ts` (event capture, typing aggregation, safe field metadata), `fingerprint.ts` (finding a clicked control again), `fullpage.ts`, `capture-bar.ts` (on-page controls) |
| Privacy | `sensitive.ts` (finds private details on screen), `redact.ts` (pixelation) |
| Side panel | `sidepanel.ts`, `sidepanel-ui.ts`, `settings-ui.ts`, `library-ui.ts` |
| Guide editor | `viewer.ts`, `viewer-ui.ts`, `guide-client.ts`, `image-editor.ts` |
| Shared UI | `client.ts` (live state from the worker), `dialog.ts` (modal sheets) |
| Export | `sop.ts` (shared HTML rendering), `docx.ts` (Word writer), `zip.ts`, `print.ts` (PDF print page) |
| Guide me | `guide.ts`, `guide-overlay.ts`, `guide-session.ts` |
| On-page button | `launcher.ts`, `launcher-ui.ts` |

`popup.ts` and `popup-ui.ts` are the legacy popup; the side panel replaced it as the toolbar UI.
