# Issue tracker: local Markdown

Issues and specs live as Markdown files in `.scratch/`.

## Conventions

- Use one directory per feature: `.scratch/<feature-slug>/`.
- Store the spec at `.scratch/<feature-slug>/spec.md`.
- Store each implementation ticket separately at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`.
  Do not combine tickets into one file.
- Record triage state in a `Status:` line near the top of each issue.
  Use the strings in `triage-labels.md`.
- Append comments and conversation history under `## Comments`.

## Publishing and fetching

When a skill says "publish to the issue tracker", create the appropriate
spec or issue file using the paths above.

When a skill says "fetch the relevant ticket", read the referenced file.
If a ticket number matches multiple features, ask which feature it belongs to.

## Wayfinding operations

The `/wayfinder` map has one child file per ticket.

- Map: `.scratch/<effort>/map.md`, containing Notes,
  Decisions-so-far, and Fog.
- Child ticket: `.scratch/<effort>/issues/<NN>-<slug>.md`,
  numbered from `01`, with the question in the body.
- Type: record `research`, `prototype`, `grilling`, or `task`
  in a `Type:` line.
- Status: use `open`, `claimed`, or `resolved` for wayfinding tickets.
  These workflow states are separate from the triage roles.
- Blocking: list dependencies in a `Blocked by: NN, NN` line.
  A ticket is unblocked when every listed ticket is `resolved`.
- Frontier: choose the lowest-numbered open, unblocked, unclaimed ticket.
- Claim: save `Status: claimed` before starting work.
- Resolve: append the answer under `## Answer`, set `Status: resolved`,
  and append a summary and ticket link to the map's Decisions-so-far.
