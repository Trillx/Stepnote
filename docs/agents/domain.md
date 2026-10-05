# Domain docs

## Layout

This project uses a single-context layout:

- `CONTEXT.md` at the repo root for domain terms and context.
- `docs/adr/` for architecture decision records.

## Before exploring

Read `CONTEXT.md` and any ADRs relevant to the work.

If these files do not exist, proceed silently. Do not flag their absence
or suggest creating them upfront. The `/domain-modeling` skill creates
them when terms or decisions are resolved. That skill can also be reached
through `/grill-with-docs` and `/improve-codebase-architecture`.

If the project later adopts a root `CONTEXT-MAP.md`, read the relevant
context files it points to and any applicable context-specific ADRs.

## Use the glossary's vocabulary

Use the terms defined in `CONTEXT.md` in issue titles, proposals,
hypotheses, and test names. Avoid synonyms the glossary rejects.

If a concept is missing, reconsider whether it belongs in the project
or note the gap for `/domain-modeling`.

## Flag ADR conflicts

Explicitly identify any existing ADR that a proposal contradicts.
Explain why the decision should be reopened rather than silently
overriding it.
