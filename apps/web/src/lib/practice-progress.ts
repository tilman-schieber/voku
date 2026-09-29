/**
 * How far a student has got through a word list, remembered on their own device.
 *
 * A list of fifty words is not learned in one sitting, and the class said so:
 * every practice round started from the whole list again. So a round is now a
 * stage of a dozen words, and the device remembers which words have been typed
 * right first time — enough to hand back the ones still missing next time.
 *
 * Deliberately *not* on the server. Voku stores a first name and a score per
 * student and nothing else; a per-child record of which words they cannot do
 * would be a different kind of data with a different kind of question attached
 * to it. The cost is that another iPad, or cleared browser data, starts fresh —
 * and that the teacher never sees any of this, which is the same rule the
 * "words to work on" list already follows.
 */
import type { Outcome } from './drill-round.ts';

/** A stage: short enough to finish in a sitting, long enough to be worth doing. */
export const STAGE_SIZE = 12;

export interface Progress {
  /** Words typed right first time, and not missed since. */
  known: string[];
  updatedAt: string;
}

export const EMPTY: Progress = { known: [], updatedAt: '' };

export interface RecordOptions {
  /**
   * Whether a word may *become* known in this round.
   *
   * False for the round of words that already needed another go: there, "right
   * first time" means the first time in a round made only of words the student
   * has just got wrong, which is not the same thing at all. Such a round can
   * still take a word off the list — going wrong is always worth remembering.
   */
  promote?: boolean;
  now?: Date;
}

/**
 * Only "right first time" counts as known. Needing another go inside the round
 * is exactly the state this is meant to remember, not to forgive — and a word
 * that goes wrong later drops out again, so the list cannot silently rot.
 */
export function record(
  progress: Progress,
  outcomes: Record<string, Outcome>,
  { promote = true, now = new Date() }: RecordOptions = {},
): Progress {
  const known = new Set(progress.known);
  for (const [wordId, outcome] of Object.entries(outcomes)) {
    if (outcome === 'first') {
      if (promote) known.add(wordId);
    } else known.delete(wordId);
  }
  return { known: [...known], updatedAt: now.toISOString() };
}

/** Counted against the list as it is now, so words the teacher removed do not inflate it. */
export function knownCount(wordIds: string[], progress: Progress): number {
  const known = new Set(progress.known);
  return wordIds.filter((id) => known.has(id)).length;
}

/**
 * The next stage: the words not yet known, in the list's own order, capped.
 *
 * Returns an empty list when the whole list is known — the caller then offers a
 * round of everything, because "finished" should mean "go again", not a wall.
 */
export function nextStage(wordIds: string[], progress: Progress, size = STAGE_SIZE): string[] {
  const known = new Set(progress.known);
  return wordIds.filter((id) => !known.has(id)).slice(0, size);
}

// ---------------------------------------------------------------------------
// The device's own memory
// ---------------------------------------------------------------------------

const PREFIX = 'voku.practice.';

/**
 * Per student, not per device. A set of school iPads is handed round, and the
 * next child to sign in on this one must not inherit the last child's stage —
 * nor see how far they had got in the header.
 */
const key = (studentId: string, listKey: string) => `${PREFIX}${studentId}.${listKey}`;

/**
 * Storage can be switched off, full, or refused outright in a private window,
 * and practice has to work anyway — so every failure here means "this device
 * remembers nothing", never an error on screen.
 */
export function load(studentId: string, listKey: string): Progress {
  try {
    const raw = window.localStorage.getItem(key(studentId, listKey));
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    const known = (parsed as Progress).known;
    if (!Array.isArray(known) || known.some((id) => typeof id !== 'string')) return EMPTY;
    return { known, updatedAt: String((parsed as Progress).updatedAt ?? '') };
  } catch {
    return EMPTY;
  }
}

export function save(studentId: string, listKey: string, progress: Progress): void {
  try {
    window.localStorage.setItem(key(studentId, listKey), JSON.stringify(progress));
  } catch {
    // Nothing to do and nothing to say: the round itself is unaffected.
  }
}

export function clear(studentId: string, listKey: string): void {
  try {
    window.localStorage.removeItem(key(studentId, listKey));
  } catch {
    // As above.
  }
}

/**
 * Drops every other student's practice record from this device, called when
 * somebody signs in. On a shared iPad the last child's word list has no
 * business outliving their lesson.
 */
export function forgetOthers(studentId: string): void {
  try {
    const mine = `${PREFIX}${studentId}.`;
    for (const stored of Object.keys(window.localStorage)) {
      if (stored.startsWith(PREFIX) && !stored.startsWith(mine)) {
        window.localStorage.removeItem(stored);
      }
    }
  } catch {
    // As above: a device that will not talk about its storage simply forgets.
  }
}
