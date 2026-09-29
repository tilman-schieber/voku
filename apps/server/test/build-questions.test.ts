import { describe, expect, it } from 'vitest';
import { BLANK, QuestionPayloadSchema } from '@voku/shared';
import {
  blankOut,
  buildOffline,
  resolveDirection,
  type BuildableWord,
} from '../src/services/build-questions.js';
import { makeRng } from '../src/services/rng.js';

function word(id: string, en: string, de: string, over: Partial<BuildableWord> = {}): BuildableWord {
  return {
    id,
    headwordEn: en,
    translationDe: de,
    acceptedEn: [],
    acceptedDe: [],
    contextSentence: null,
    difficulty: 5,
    ...over,
  };
}

const VOCAB = [
  word('w1', 'reluctant', 'widerwillig'),
  word('w2', 'thorough', 'gründlich'),
  word('w3', 'scarcely', 'kaum'),
  word('w4', 'ambush', 'Hinterhalt'),
  word('w5', 'nevertheless', 'dennoch'),
];

const rng = () => makeRng(42);

describe('resolveDirection', () => {
  it('passes a fixed direction straight through', () => {
    expect(resolveDirection('de_en', 0)).toBe('de_en');
    expect(resolveDirection('de_en', 7)).toBe('de_en');
    expect(resolveDirection('en_de', 3)).toBe('en_de');
  });

  it('alternates for a mixed test so the split is even', () => {
    const directions = Array.from({ length: 6 }, (_, i) => resolveDirection('mixed', i));
    expect(directions).toEqual(['de_en', 'en_de', 'de_en', 'en_de', 'de_en', 'en_de']);
  });
});

describe('blankOut', () => {
  it('replaces the exact word with a gap', () => {
    const r = blankOut('She was reluctant to answer.', 'reluctant');
    expect(r?.sentence).toBe(`She was ${BLANK} to answer.`);
    expect(r?.surface).toBe('reluctant');
  });

  it('finds a regular inflection and keeps the surface form as the answer', () => {
    const r = blankOut('He answered thoroughly.', 'thorough');
    expect(r?.sentence).toBe(`He answered ${BLANK}.`);
    expect(r?.surface).toBe('thoroughly');
  });

  it('finds a doubled-consonant inflection', () => {
    const r = blankOut('She slammed the door.', 'slam');
    expect(r?.sentence).toBe(`She ${BLANK} the door.`);
    expect(r?.surface).toBe('slammed');
  });

  it('matches case-insensitively but keeps the original casing as the answer', () => {
    const r = blankOut('Reluctant students learn slowly.', 'reluctant');
    expect(r?.surface).toBe('Reluctant');
  });

  it('does not match inside a longer unrelated word', () => {
    expect(blankOut('The scarf was red.', 'scar')).toBeNull();
  });

  it('returns null when the word simply is not there', () => {
    expect(blankOut('Nothing to see here.', 'reluctant')).toBeNull();
  });

  it('survives regex metacharacters in the headword', () => {
    expect(() => blankOut('costs $5 (roughly).', 'a.b*c')).not.toThrow();
  });
});

describe('buildOffline', () => {
  it('builds a typed translation in the requested direction', () => {
    const [q] = buildOffline(VOCAB, [{ wordId: 'w1', type: 'translate_input' }], {
      direction: 'de_en',
      rng: rng(),
    });

    expect(q!.payload).toMatchObject({
      type: 'translate_input',
      direction: 'de_en',
      prompt: 'widerwillig',
      accepted: ['reluctant'],
    });
  });

  it('flips prompt and answer for en_de', () => {
    const [q] = buildOffline(VOCAB, [{ wordId: 'w1', type: 'translate_input' }], {
      direction: 'en_de',
      rng: rng(),
    });
    expect(q!.payload).toMatchObject({ prompt: 'reluctant', accepted: ['widerwillig'] });
  });

  it('includes the teacher’s alternative answers, deduplicated', () => {
    const w = word('x', 'reluctant', 'widerwillig', { acceptedEn: ['unwilling', 'reluctant'] });
    const [q] = buildOffline([w], [{ wordId: 'x', type: 'translate_input' }], {
      direction: 'de_en',
      rng: rng(),
    });
    expect((q!.payload as { accepted: string[] }).accepted).toEqual(['reluctant', 'unwilling']);
  });

  it('builds multiple choice with distractors taken from the other words', () => {
    const [q] = buildOffline(VOCAB, [{ wordId: 'w1', type: 'mcq_translation' }], {
      direction: 'de_en',
      rng: rng(),
    });

    expect(q!.type).toBe('mcq_translation');
    const payload = q!.payload as { options: string[]; correctIndex: number };
    expect(payload.options).toHaveLength(4);
    expect(payload.options[payload.correctIndex]).toBe('reluctant');
    for (const option of payload.options) {
      expect(VOCAB.map((w) => w.headwordEn)).toContain(option);
    }
  });

  it('does not place the correct option in the same slot every time', () => {
    const positions = new Set<number>();
    for (let seed = 0; seed < 25; seed++) {
      const [q] = buildOffline(VOCAB, [{ wordId: 'w1', type: 'mcq_translation' }], {
        direction: 'de_en',
        rng: makeRng(seed),
      });
      positions.add((q!.payload as { correctIndex: number }).correctIndex);
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it('downgrades multiple choice when there are not enough words for distractors', () => {
    const pair = [VOCAB[0]!, VOCAB[1]!];
    const [q] = buildOffline(pair, [{ wordId: 'w1', type: 'mcq_translation' }], {
      direction: 'de_en',
      rng: rng(),
    });
    expect(q!.type).toBe('translate_input');
    expect(q!.downgradedFrom).toBe('mcq_translation');
  });

  it('builds a gap question from the sentence the word appeared in', () => {
    const w = word('w9', 'reluctant', 'widerwillig', {
      contextSentence: 'She was reluctant to answer the question.',
    });
    const [q] = buildOffline([w], [{ wordId: 'w9', type: 'fill_blank' }], {
      direction: 'de_en',
      rng: rng(),
    });

    expect(q!.type).toBe('fill_blank');
    expect(q!.payload).toMatchObject({
      sentence: `She was ${BLANK} to answer the question.`,
      accepted: ['reluctant'],
      hint: 'widerwillig',
    });
  });

  it('downgrades a gap question when there is no usable sentence', () => {
    const [q] = buildOffline(VOCAB, [{ wordId: 'w1', type: 'fill_blank' }], {
      direction: 'de_en',
      rng: rng(),
    });
    expect(q!.type).toBe('translate_input');
    expect(q!.downgradedFrom).toBe('fill_blank');
  });

  it('always downgrades definition MCQ, which needs prose written for it', () => {
    const [q] = buildOffline(VOCAB, [{ wordId: 'w1', type: 'mcq_definition' }], {
      direction: 'de_en',
      rng: rng(),
    });
    expect(q!.type).toBe('translate_input');
    expect(q!.downgradedFrom).toBe('mcq_definition');
  });

  it('produces payloads that all pass the shared schema', () => {
    const assignments = [
      { wordId: 'w1', type: 'translate_input' as const },
      { wordId: 'w2', type: 'mcq_translation' as const },
      { wordId: 'w3', type: 'fill_blank' as const },
      { wordId: 'w4', type: 'mcq_definition' as const },
    ];
    const built = buildOffline(
      VOCAB.map((w) => (w.id === 'w3' ? { ...w, contextSentence: 'They had scarcely arrived.' } : w)),
      assignments,
      { direction: 'mixed', rng: rng() },
    );

    expect(built).toHaveLength(4);
    for (const q of built) {
      expect(() => QuestionPayloadSchema.parse(q.payload)).not.toThrow();
    }
  });

  it('skips an assignment whose word is missing rather than crashing', () => {
    const built = buildOffline(VOCAB, [{ wordId: 'ghost', type: 'translate_input' }], {
      direction: 'de_en',
      rng: rng(),
    });
    expect(built).toEqual([]);
  });
});

/**
 * The class asked for this: a bare word carries no sense with it.  is
 * *ansprechen* or *thematisieren* depending on the sentence, and without the
 * sentence the student is guessing which one is wanted.
 */
describe('the sentence under a typed question', () => {
  const ADDRESS = word('w9', 'address', 'thematisieren', {
    contextSentence: 'In his speech, the politician failed to address the core issues.',
  });

  const typed = (w: BuildableWord, direction: 'de_en' | 'en_de') =>
    buildOffline([w], [{ wordId: w.id, type: 'translate_input' }], { direction, rng: rng() })[0]!
      .payload as { type: 'translate_input'; context?: string };

  it('shows the sentence as written when the answer is the German', () => {
    expect(typed(ADDRESS, 'en_de').context).toBe(ADDRESS.contextSentence);
  });

  // The same sentence asked the other way round would contain the answer.
  it('blanks the word out when the answer is the English', () => {
    const context = typed(ADDRESS, 'de_en').context!;
    expect(context).toContain(BLANK);
    expect(context.toLowerCase()).not.toContain('address');
  });

  it('shows nothing rather than the answer when the word is not in the sentence', () => {
    const odd = word('w10', 'thorough', 'gründlich', { contextSentence: 'She checked it twice.' });
    expect(typed(odd, 'de_en').context).toBeUndefined();
  });

  it('shows nothing when the word has no sentence yet', () => {
    expect(typed(word('w11', 'weary', 'müde'), 'en_de').context).toBeUndefined();
  });
});
