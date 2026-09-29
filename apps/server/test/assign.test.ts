import { describe, expect, it } from 'vitest';
import type { MixWeights } from '@voku/shared';
import {
  MIN_TRICKINESS_FOR_MCQ,
  assignFormats,
  type AssignableWord,
} from '../src/services/assign.js';

function word(id: string, over: Partial<AssignableWord> = {}): AssignableWord {
  return {
    id,
    difficulty: 5,
    trickiness: 0,
    suitsFillBlank: true,
    suitsDefinitionMcq: true,
    ...over,
  };
}

const evenMix: MixWeights = {
  translate_input: 25,
  mcq_translation: 25,
  mcq_definition: 25,
  fill_blank: 25,
};

const typedOnly: MixWeights = {
  translate_input: 100,
  mcq_translation: 0,
  mcq_definition: 0,
  fill_blank: 0,
};

function typeOf(result: ReturnType<typeof assignFormats>, id: string) {
  return result.assignments.find((a) => a.wordId === id)?.type;
}

describe('assignFormats', () => {
  it('gives every word exactly one question', () => {
    const words = Array.from({ length: 40 }, (_, i) => word(`w${i}`));
    const { assignments, report } = assignFormats(words, evenMix);

    expect(assignments).toHaveLength(40);
    expect(new Set(assignments.map((a) => a.wordId)).size).toBe(40);
    expect(report.total).toBe(40);
    expect(Object.values(report.achieved).reduce((a, b) => a + b, 0)).toBe(40);
  });

  it('handles an empty word list', () => {
    const { assignments, report } = assignFormats([], evenMix);
    expect(assignments).toEqual([]);
    expect(report.total).toBe(0);
    expect(report.shortfalls).toEqual([]);
  });

  describe('multiple choice is reserved for traps', () => {
    it('keeps multiple choice away from the easier half of the test', () => {
      const words = [
        ...Array.from({ length: 5 }, (_, i) => word(`easy${i}`, { difficulty: 2 })),
        ...Array.from({ length: 5 }, (_, i) => word(`hard${i}`, { difficulty: 9 })),
      ];
      const result = assignFormats(words, {
        translate_input: 50,
        mcq_translation: 50,
        mcq_definition: 0,
        fill_blank: 0,
      });

      const mcq = result.assignments.filter((a) => a.type === 'mcq_translation');
      expect(mcq).toHaveLength(5);
      expect(mcq.every((a) => a.wordId.startsWith('hard'))).toBe(true);
    });

    it('judges "hard" against this test, not against a fixed number', () => {
      // Models calibrate differently. A text whose hardest words score 5 must
      // still produce multiple choice, or a conservative model silently empties
      // the format.
      const words = [
        ...Array.from({ length: 4 }, (_, i) => word(`low${i}`, { difficulty: 2 })),
        ...Array.from({ length: 4 }, (_, i) => word(`top${i}`, { difficulty: 5 })),
      ];
      const result = assignFormats(words, {
        translate_input: 50,
        mcq_translation: 50,
        mcq_definition: 0,
        fill_blank: 0,
      });

      const mcq = result.assignments.filter((a) => a.type === 'mcq_translation');
      expect(mcq.length).toBeGreaterThan(0);
      expect(mcq.every((a) => a.wordId.startsWith('top'))).toBe(true);
    });

    it('still lets a trap qualify however easy the word is', () => {
      // "become" is A1-easy and a classic false friend.
      const words = [
        word('trap', { trickiness: 3, difficulty: 1 }),
        ...Array.from({ length: 5 }, (_, i) => word(`hard${i}`, { difficulty: 9 })),
      ];
      const result = assignFormats(words, {
        translate_input: 80,
        mcq_translation: 20,
        mcq_definition: 0,
        fill_blank: 0,
      });
      expect(typeOf(result, 'trap')).toBe('mcq_translation');
    });

    it('still prefers a trap over a merely hard word when slots are scarce', () => {
      const words = [
        word('trap', { trickiness: 3, difficulty: 3 }),
        word('hard', { trickiness: 0, difficulty: 10 }),
        word('plain-a', { trickiness: 0, difficulty: 2 }),
        word('plain-b', { trickiness: 0, difficulty: 2 }),
      ];
      // Both are eligible; preference decides.
      const result = assignFormats(words, {
        translate_input: 75,
        mcq_translation: 25,
        mcq_definition: 0,
        fill_blank: 0,
      });
      expect(typeOf(result, 'trap')).toBe('mcq_translation');
      expect(typeOf(result, 'hard')).not.toBe('mcq_translation');
    });

    it('prefers the trickiest words for the MCQ slots it does have', () => {
      const words = [
        word('plain-a', { trickiness: 0, difficulty: 3 }),
        word('trap-strong', { trickiness: 3, difficulty: 3 }),
        word('plain-b', { trickiness: 0, difficulty: 3 }),
        word('trap-weak', { trickiness: MIN_TRICKINESS_FOR_MCQ, difficulty: 3 }),
      ];
      // One MCQ slot out of four words.
      const result = assignFormats(words, {
        translate_input: 75,
        mcq_translation: 25,
        mcq_definition: 0,
        fill_blank: 0,
      });

      expect(typeOf(result, 'trap-strong')).toBe('mcq_translation');
      expect(typeOf(result, 'trap-weak')).not.toBe('mcq_translation');
    });

    it('reports a shortfall rather than giving every easy word multiple choice', () => {
      // One trap plus nine clearly easier words, asking for all-MCQ. Only the
      // trap and the top of the difficulty range can honestly take it.
      const words = [
        word('trap', { trickiness: 3, difficulty: 1 }),
        ...Array.from({ length: 9 }, (_, i) =>
          word(`plain${i}`, { trickiness: 0, difficulty: i < 6 ? 1 : 4 }),
        ),
      ];
      const { report } = assignFormats(words, {
        translate_input: 0,
        mcq_translation: 100,
        mcq_definition: 0,
        fill_blank: 0,
      });

      expect(report.achieved.mcq_translation).toBeLessThan(10);
      const shortfall = report.shortfalls.find((s) => s.type === 'mcq_translation');
      expect(shortfall?.reason).toContain('free guess');
      // Nothing is lost — the rest still became questions.
      expect(
        report.achieved.mcq_translation + report.achieved.translate_input,
      ).toBe(10);
    });
  });

  describe('definition MCQ needs a hard, definable word', () => {
    it('cannot fill the format from a uniformly easy list', () => {
      // A flat, uniformly easy list: nothing stands out as the harder end.
      const words = [
        ...Array.from({ length: 8 }, (_, i) => word(`easy${i}`, { difficulty: 1 })),
        ...Array.from({ length: 2 }, (_, i) => word(`less${i}`, { difficulty: 2 })),
      ];
      const { report } = assignFormats(words, {
        translate_input: 50,
        mcq_translation: 0,
        mcq_definition: 50,
        fill_blank: 0,
      });
      // Only the top of the range is eligible, so the format cannot be filled.
      expect(report.achieved.mcq_definition).toBeLessThan(5);
      expect(report.shortfalls.some((s) => s.type === 'mcq_definition')).toBe(true);
    });

    it('skips words the extractor said cannot be defined, however hard they are', () => {
      const words = Array.from({ length: 10 }, (_, i) =>
        word(`hard${i}`, { difficulty: 10, suitsDefinitionMcq: false }),
      );
      const { report } = assignFormats(words, {
        translate_input: 50,
        mcq_translation: 0,
        mcq_definition: 50,
        fill_blank: 0,
      });
      expect(report.achieved.mcq_definition).toBe(0);
      expect(report.shortfalls.some((s) => s.type === 'mcq_definition')).toBe(true);
    });
  });

  it('only puts gap-suitable words in a gap sentence', () => {
    const words = [
      word('fits', { suitsFillBlank: true }),
      ...Array.from({ length: 5 }, (_, i) => word(`nofit${i}`, { suitsFillBlank: false })),
    ];
    const result = assignFormats(words, {
      translate_input: 50,
      mcq_translation: 0,
      mcq_definition: 0,
      fill_blank: 50,
    });

    const fillBlanks = result.assignments.filter((a) => a.type === 'fill_blank');
    expect(fillBlanks).toHaveLength(1);
    expect(fillBlanks[0]!.wordId).toBe('fits');
  });

  it('honours a typed-only mix exactly', () => {
    const words = Array.from({ length: 12 }, (_, i) => word(`w${i}`, { trickiness: 3, difficulty: 10 }));
    const { report } = assignFormats(words, typedOnly);

    expect(report.achieved.translate_input).toBe(12);
    expect(report.achieved.mcq_translation).toBe(0);
    expect(report.shortfalls).toEqual([]);
  });

  it('falls back to typed translation when no weights are given at all', () => {
    const words = Array.from({ length: 5 }, (_, i) => word(`w${i}`));
    const { report } = assignFormats(words, {
      translate_input: 0,
      mcq_translation: 0,
      mcq_definition: 0,
      fill_blank: 0,
    });
    expect(report.achieved.translate_input).toBe(5);
  });

  it('splits proportionally when every word is eligible for everything', () => {
    const words = Array.from({ length: 40 }, (_, i) =>
      word(`w${i}`, { trickiness: 3, difficulty: 10, suitsFillBlank: true, suitsDefinitionMcq: true }),
    );
    const { report } = assignFormats(words, evenMix);

    for (const type of ['translate_input', 'mcq_translation', 'mcq_definition', 'fill_blank'] as const) {
      expect(report.achieved[type]).toBe(10);
    }
    expect(report.shortfalls).toEqual([]);
  });

  it('rounds without losing or inventing a question', () => {
    // 7 words over a 3-way split cannot divide evenly.
    const words = Array.from({ length: 7 }, (_, i) => word(`w${i}`, { trickiness: 3, difficulty: 10 }));
    const { assignments, report } = assignFormats(words, {
      translate_input: 33,
      mcq_translation: 33,
      mcq_definition: 34,
      fill_blank: 0,
    });

    expect(assignments).toHaveLength(7);
    expect(Object.values(report.achieved).reduce((a, b) => a + b, 0)).toBe(7);
  });

  /**
   * The teacher's override. The rule it lifts exists because a wrong answer
   * costs nothing, so four options on an easy word are a free quarter mark —
   * but a text with no traps otherwise yields a test that is nothing but
   * typing, and that is a worse lesson than a slightly inflated score.
   */
  describe('multiple choice on any word', () => {
    const easy = Array.from({ length: 12 }, (_, i) =>
      word(`e${i}`, { difficulty: 1, trickiness: 0, suitsDefinitionMcq: true }),
    );

    it('is off by default, so an easy list gets no multiple choice', () => {
      const { report } = assignFormats(easy, evenMix);
      expect(report.achieved.mcq_translation).toBe(0);
      expect(report.achieved.mcq_definition).toBe(0);
      expect(report.shortfalls.map((s) => s.type)).toContain('mcq_translation');
    });

    it('gives the same easy list its choices when the teacher turns it on', () => {
      const { report } = assignFormats(easy, evenMix, { anyWord: true });
      expect(report.achieved.mcq_translation).toBeGreaterThan(0);
      expect(report.achieved.mcq_definition).toBeGreaterThan(0);
    });

    // A definition still has to be worth writing; the switch is about difficulty.
    it('still keeps definition questions to words that can be defined', () => {
      const undefinable = easy.map((w) => ({ ...w, suitsDefinitionMcq: false }));
      const { report } = assignFormats(undefinable, evenMix, { anyWord: true });
      expect(report.achieved.mcq_definition).toBe(0);
    });

    it('still lets a trap be a choice when it is off', () => {
      const words = [
        ...easy,
        word('trap', { trickiness: MIN_TRICKINESS_FOR_MCQ, difficulty: 1 }),
      ];
      expect(typeOf(assignFormats(words, evenMix), 'trap')).toBe('mcq_translation');
    });
  });

  it('is deterministic — the same input always produces the same assignment', () => {
    const words = Array.from({ length: 30 }, (_, i) =>
      word(`w${i}`, { trickiness: i % 4, difficulty: (i % 10) + 1, suitsFillBlank: i % 2 === 0 }),
    );
    const first = assignFormats(words, evenMix);
    const second = assignFormats([...words].reverse(), evenMix);

    const sort = (r: typeof first) =>
      [...r.assignments].sort((a, b) => a.wordId.localeCompare(b.wordId));
    expect(sort(first)).toEqual(sort(second));
  });
});
