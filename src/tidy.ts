// "Tidy up steps": a local, rule-based clean-up run when a capture completes.
// It never changes a step the author has edited (text or note).
import { isStep, type Entry, type Step } from './recorder.ts';
import type { Fingerprint } from './fingerprint.ts';

const edited = (step: Step) => step.text !== undefined || step.note !== undefined;
const sameControl = (a?: Fingerprint, b?: Fingerprint) => !!a && !!b && (a.id && b.id ? a.id === b.id : a.selector === b.selector);

export function tidySteps(entries: Entry[]): { steps: Entry[]; removed: number } {
  const out: Entry[] = [];
  let removed = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const next = entries[i + 1];
    if (isStep(entry) && entry.kind === undefined && !edited(entry)) {
      // A click on a field, then typing in that same field: one step.
      const field = entry.label.match(/^Click the "(.+)" field$/);
      if (field && next && isStep(next) && next.kind === 'type' && !edited(next) && next.url === entry.url && next.route === entry.route && sameControl(entry.target, next.target)) {
        const typed = next.label.match(/^Type (".*")$/s);
        if (typed) next.text = `Type **${typed[1]}** in the **${field[1]}** field`;
        removed++;
        continue;
      }
      // The same control clicked again within a second: keep the first.
      const previous = out[out.length - 1];
      if (previous && isStep(previous) && previous.kind === undefined && previous.label === entry.label && previous.url === entry.url && previous.route === entry.route &&
          sameControl(previous.target, entry.target) && entry.at - previous.at < 1000) { removed++; continue; }
    }
    out.push(entry);
  }
  return { steps: out, removed };
}
