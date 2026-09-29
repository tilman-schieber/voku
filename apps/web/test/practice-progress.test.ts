import { beforeEach, describe, expect, it } from 'vitest';
import type { Outcome } from '../src/lib/drill-round.ts';
import {
  EMPTY,
  STAGE_SIZE,
  forgetOthers,
  knownCount,
  load,
  nextStage,
  record,
  save,
  type Progress,
} from '../src/lib/practice-progress.ts';

/**
 * A fifty-word list is learned in stages, and the device remembers which stage
 * the student is on. The rules that decide what counts as learned are here;
 * where it is kept — this iPad and nowhere else — is the other half of the
 * decision and lives in the module's own comment.
 */

const LIST = Array.from({ length: 30 }, (_, i) => `w${i + 1}`);

const outcomes = (entries: Record<string, Outcome>) => entries;

describe('what counts as known', () => {
  it('takes a word typed right first time', () => {
    const after = record(EMPTY, outcomes({ w1: 'first', w2: 'first' }));
    expect(after.known).toEqual(['w1', 'w2']);
  });

  // Needing another go is precisely the state worth remembering.
  it('does not take a word that needed another go', () => {
    const after = record(EMPTY, outcomes({ w1: 'recovered', w2: 'missed' }));
    expect(after.known).toEqual([]);
  });

  it('drops a word that has gone wrong since', () => {
    const before: Progress = { known: ['w1', 'w2'], updatedAt: '' };
    expect(record(before, outcomes({ w1: 'missed' })).known).toEqual(['w2']);
  });

  it('leaves words the round did not ask about alone', () => {
    const before: Progress = { known: ['w9'], updatedAt: '' };
    expect(record(before, outcomes({ w1: 'first' })).known).toContain('w9');
  });
});

describe('the next stage', () => {
  it('is a dozen words, not the whole list', () => {
    expect(nextStage(LIST, EMPTY)).toHaveLength(STAGE_SIZE);
    expect(nextStage(LIST, EMPTY)[0]).toBe('w1');
  });

  it('carries on where the last one stopped', () => {
    const after = record(EMPTY, Object.fromEntries(LIST.slice(0, 12).map((id) => [id, 'first' as Outcome])));
    expect(nextStage(LIST, after)[0]).toBe('w13');
  });

  // A word that went wrong stays in the queue rather than being passed over.
  it('brings back a word that was not right first time', () => {
    const after = record(
      EMPTY,
      outcomes({ w1: 'first', w2: 'recovered', w3: 'first', w4: 'missed' }),
    );
    expect(nextStage(LIST, after).slice(0, 2)).toEqual(['w2', 'w4']);
  });

  it('is empty once the whole list is known, so the caller can offer it all again', () => {
    const all = record(EMPTY, Object.fromEntries(LIST.map((id) => [id, 'first' as Outcome])));
    expect(nextStage(LIST, all)).toEqual([]);
  });

  it('counts progress against the list as it stands today', () => {
    const stale: Progress = { known: ['w1', 'gone-from-the-list'], updatedAt: '' };
    expect(knownCount(LIST, stale)).toBe(1);
  });
});

/**
 * The round of words that already went wrong is not a fresh start for them.
 * Getting one right among a handful you have just missed is not the same as
 * getting it right in the stage, and recording it as known would quietly undo
 * the rule the whole thing rests on.
 */
describe('the round of ones that needed another go', () => {
  it('cannot make a word known', () => {
    const after = record(EMPTY, outcomes({ w1: 'first', w2: 'first' }), { promote: false });
    expect(after.known).toEqual([]);
  });

  // It can still take one off: going wrong is always worth remembering.
  it('still drops a word that goes wrong again', () => {
    const before: Progress = { known: ['w1', 'w2'], updatedAt: '' };
    const after = record(before, outcomes({ w1: 'missed' }), { promote: false });
    expect(after.known).toEqual(['w2']);
  });
});

/**
 * School iPads are handed round. What one child has practised must not greet
 * the next child as their own progress.
 */
describe('a device shared between students', () => {
  // Stored items are the object's own keys and the methods live on its
  // prototype, which is how a real Storage behaves under Object.keys().
  const methods = {
    getItem(this: Record<string, string>, k: string) {
      return this[k] ?? null;
    },
    setItem(this: Record<string, string>, k: string, v: string) {
      this[k] = v;
    },
    removeItem(this: Record<string, string>, k: string) {
      delete this[k];
    },
  };

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: Object.create(methods) };
  });

  it('keeps one student’s progress out of another’s hands', () => {
    save('lena', 'test:unit-3', { known: ['w1', 'w2'], updatedAt: '' });
    expect(load('lena', 'test:unit-3').known).toEqual(['w1', 'w2']);
    expect(load('jonas', 'test:unit-3')).toEqual(EMPTY);
  });

  it('forgets the last student when the next one signs in', () => {
    save('lena', 'test:unit-3', { known: ['w1'], updatedAt: '' });
    save('jonas', 'test:unit-3', { known: ['w9'], updatedAt: '' });

    forgetOthers('jonas');

    expect(load('jonas', 'test:unit-3').known).toEqual(['w9']);
    expect(load('lena', 'test:unit-3')).toEqual(EMPTY);
  });
});
