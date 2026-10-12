# Stepnote

A Chrome browser extension for capturing standard operating procedures
with screenshots and recorded clicks.

## Checks

Run `npm run check` (tests, typecheck, build) before calling work done.
Put new tests in the file for the module or behavior they cover, not in
a file named after a review or audit. Do not bump the version by hand;
releases use `npm version` (see the README's Release section).

## Agent skills

### Issue tracker

Track issues and specs as local Markdown files under `.scratch/<feature>/`.
See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage roles as issue status strings.
See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout with root `CONTEXT.md` and `docs/adr/`.
See `docs/agents/domain.md`.
