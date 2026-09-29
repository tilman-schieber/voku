import {
  QUESTION_TYPES,
  type AchievedMix,
  type MixWeights,
  type QuestionType,
} from '@voku/shared';

/**
 * Deciding which format each word gets.
 *
 * Two rules shape this, and they pull against each other:
 *
 *  1. Wrong answers cost nothing, so a guessable format must never be a free
 *     ride. Multiple choice is therefore *reserved* for words where the wrong
 *     options are genuine traps — false friends and confusables (trickiness),
 *     or words hard enough that an English definition is real work.
 *  2. The teacher's mix is a set of preferences, not quotas. A text with three
 *     tricky words cannot support ten multiple-choice questions, and inventing
 *     seven fake traps would be worse than honestly reporting the shortfall.
 *
 * So: eligibility is a hard gate, weights fill what's left, and anything that
 * couldn't be honoured comes back in the report rather than being papered over.
 */

export interface AssignableWord {
  id: string;
  difficulty: number;
  trickiness: number;
  suitsFillBlank: boolean;
  suitsDefinitionMcq: boolean;
}

/** Below this, the distractors would be arbitrary rather than tempting. */
export const MIN_TRICKINESS_FOR_MCQ = 2;

/**
 * "Hard" means the top 40% of *this* test, not a fixed score: models calibrate
 * differently, and a fixed cutoff silently empties both MCQ formats when one
 * scores conservatively. The floor stops a uniformly trivial list qualifying.
 */
export const HARD_PERCENTILE = 0.6;
export const ABSOLUTE_EASY_CEILING = 4;

function hardnessCutoff(words: AssignableWord[]): number {
  if (words.length === 0) return ABSOLUTE_EASY_CEILING;
  const sorted = words.map((w) => w.difficulty).sort((a, b) => a - b);
  const percentile = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * HARD_PERCENTILE))]!;
  return Math.max(ABSOLUTE_EASY_CEILING, percentile);
}

function eligibility(
  words: AssignableWord[],
  anyWord: boolean,
): Record<QuestionType, (w: AssignableWord) => boolean> {
  const hard = hardnessCutoff(words);
  return {
    // A trap, or one of the harder words here — never an easy free 25%, unless
    // the teacher has decided for this test that a mix of formats matters more.
    mcq_translation: (w) => anyWord || w.trickiness >= MIN_TRICKINESS_FOR_MCQ || w.difficulty >= hard,
    // Still needs a definition worth writing, whatever the setting says.
    mcq_definition: (w) => w.suitsDefinitionMcq && (anyWord || w.difficulty >= hard),
    fill_blank: (w) => w.suitsFillBlank,
    translate_input: () => true,
  };
}

/** Best-fit first, so the scarce format gets the words it suits most. */
const PREFERENCE: Record<QuestionType, (a: AssignableWord, b: AssignableWord) => number> = {
  mcq_translation: (a, b) => b.trickiness - a.trickiness || b.difficulty - a.difficulty,
  mcq_definition: (a, b) => b.difficulty - a.difficulty,
  fill_blank: (a, b) => b.difficulty - a.difficulty,
  translate_input: () => 0,
};

function shortfallReason(type: QuestionType, anyWord: boolean): string {
  switch (type) {
    case 'mcq_translation':
      return anyWord
        ? 'there were not enough other words on the list to build the wrong options from'
        : 'multiple choice only goes to traps and to the harder words in this test — on an easy one it would be a free guess';
    case 'mcq_definition':
      return anyWord
        ? 'only words that can be defined in plain English are worth this format'
        : 'only the harder words that can be defined in plain English are worth this format';
    case 'fill_blank':
      return 'only some words sit naturally in a gap sentence';
    case 'translate_input':
      return 'every word can be typed, so this should never fall short';
  }
}

/**
 * Scarce formats are allocated before abundant ones, and typed translation goes
 * last because it is the one format every word is eligible for — it absorbs
 * whatever is left without ever failing.
 */
const ORDER: QuestionType[] = ['mcq_translation', 'mcq_definition', 'fill_blank', 'translate_input'];

export interface Assignment {
  wordId: string;
  type: QuestionType;
}

export interface AssignmentResult {
  assignments: Assignment[];
  report: AchievedMix;
}

/** Largest-remainder, so the parts sum to the whole instead of drifting by rounding. */
function desiredCounts(weights: MixWeights, total: number): Record<QuestionType, number> {
  const sum = QUESTION_TYPES.reduce((acc, t) => acc + weights[t], 0);
  const counts = {} as Record<QuestionType, number>;

  if (sum <= 0) {
    // No preference expressed: everything becomes a typed translation.
    for (const type of QUESTION_TYPES) counts[type] = 0;
    counts.translate_input = total;
    return counts;
  }

  const exact = QUESTION_TYPES.map((type) => ({ type, value: (weights[type] / sum) * total }));
  let assigned = 0;
  for (const { type, value } of exact) {
    counts[type] = Math.floor(value);
    assigned += counts[type];
  }
  const remainders = exact
    .map(({ type, value }) => ({ type, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || ORDER.indexOf(a.type) - ORDER.indexOf(b.type));

  for (let i = 0; assigned < total; i++, assigned++) {
    counts[remainders[i % remainders.length]!.type]++;
  }
  return counts;
}

export interface AssignOptions {
  /** Multiple choice may go to any word, not only traps and the harder ones. */
  anyWord?: boolean;
}

export function assignFormats(
  words: AssignableWord[],
  weights: MixWeights,
  { anyWord = false }: AssignOptions = {},
): AssignmentResult {
  const achieved = Object.fromEntries(QUESTION_TYPES.map((t) => [t, 0])) as Record<
    QuestionType,
    number
  >;
  const shortfalls: AchievedMix['shortfalls'] = [];
  const assignments: Assignment[] = [];

  if (words.length === 0) {
    return { assignments, report: { requested: weights, achieved, total: 0, shortfalls } };
  }

  const wanted = desiredCounts(weights, words.length);
  const unassigned = new Map(words.map((w) => [w.id, w]));
  const ELIGIBLE = eligibility(words, anyWord);

  for (const type of ORDER) {
    const want = wanted[type];
    if (want <= 0) continue;

    const candidates = [...unassigned.values()]
      .filter(ELIGIBLE[type])
      // Sort by fit, then by id so the same input always gives the same output.
      .sort((a, b) => PREFERENCE[type](a, b) || a.id.localeCompare(b.id));

    const take = candidates.slice(0, want);
    for (const word of take) {
      assignments.push({ wordId: word.id, type });
      unassigned.delete(word.id);
      achieved[type]++;
    }

    if (take.length < want) {
      shortfalls.push({
        type,
        wanted: want,
        got: take.length,
        reason: shortfallReason(type, anyWord),
      });
    }
  }

  // Anything a shortfall left behind falls back to the universally eligible format.
  for (const word of unassigned.values()) {
    assignments.push({ wordId: word.id, type: 'translate_input' });
    achieved.translate_input++;
  }

  return {
    assignments,
    report: { requested: weights, achieved, total: words.length, shortfalls },
  };
}
