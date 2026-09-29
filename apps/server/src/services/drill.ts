import {
  acceptedAnswers,
  stripAnswer,
  type DrillChoice,
  type DrillItem,
  type QuestionPayload,
} from '@voku/shared';
import type { Db } from '../db/index.js';
import { buildOffline } from './build-questions.js';
import { normalise } from './grading.js';
import { makeRng, seedFrom } from './rng.js';
import { includedWords, toBuildable, type TestRow } from './tests.js';

/**
 * Drilling the word pairs before a test.
 *
 * Shared by the student's practice screen and the teacher's preview of it, so
 * what the teacher checks is literally what the class will be asked. Nothing
 * here writes: practice is a study aid, not a measurement.
 */

/**
 * The whole list is built and one question picked out of it, rather than
 * building the single word asked for: on a `mixed` test the direction comes
 * from the word's position, so the two would disagree and a student could be
 * asked one way and marked the other.
 */
export function drillPayloads(db: Db, test: TestRow): Map<string, QuestionPayload> {
  const words = includedWords(db, test.id);
  const built = buildOffline(
    words.map(toBuildable),
    words.map((word) => ({ wordId: word.id, type: 'translate_input' as const })),
    { direction: test.direction, rng: makeRng(seedFrom(test.id)) },
  );
  return new Map(built.map((question) => [question.wordId, question.payload]));
}

/** A choice needs the right answer and at least two believable wrong ones. */
const MIN_OPTIONS = 3;

/**
 * One word as multiple choice, for the second attempt after a miss.
 *
 * Built offline from the other words on the list — the same way a test without
 * a model builds its choices — and never from the questions stored for the test.
 * Those carry the traps the model wrote, and practising on them would spend them
 * before the sprint.
 *
 * Built over the whole list for the same reason as the typed drill: on a `mixed`
 * test the direction follows the word's position, and the choice must ask the
 * same way round as the typing it stands in for.
 *
 * Returns null for a word not on the list, and a choice with no options when a
 * fair one cannot be made — the drill then simply asks the word again.
 */
export function drillChoice(db: Db, test: TestRow, wordId: string): DrillChoice | null {
  const words = includedWords(db, test.id);
  if (!words.some((word) => word.id === wordId)) return null;

  const built = buildOffline(
    words.map(toBuildable),
    words.map((word) => ({ wordId: word.id, type: 'mcq_translation' as const })),
    { direction: test.direction, rng: makeRng(seedFrom(`${test.id}:choice`)) },
  ).find((question) => question.wordId === wordId)!;

  const typed = drillPayloads(db, test).get(wordId)!;
  const empty = (): DrillChoice => {
    const safe = stripAnswer(typed);
    return safe.type === 'translate_input'
      ? { wordId, prompt: safe.prompt, direction: safe.direction, options: [] }
      : { wordId, prompt: '', direction: 'de_en', options: [] };
  };

  // Too few other words on the list to make a choice of it.
  if (built.payload.type !== 'mcq_translation') return empty();

  // Near-synonyms: a wrong option that the grader would accept is a second right
  // answer, and a choice with two right answers teaches nothing. The test's own
  // multiple choice has this problem too; here it can at least be filtered out.
  const payload = built.payload;
  const correct = payload.options[payload.correctIndex]!;
  const alsoRight = new Set((acceptedAnswers(typed) ?? []).map(normalise));
  const options = payload.options.filter(
    (option) => option === correct || !alsoRight.has(normalise(option)),
  );
  if (options.length < MIN_OPTIONS) return empty();

  // stripAnswer is the only path from a question to a student.
  const safe = stripAnswer({ ...payload, options, correctIndex: options.indexOf(correct) });
  if (safe.type !== 'mcq_translation') return empty();
  return { wordId, prompt: safe.prompt, direction: safe.direction, options: safe.options };
}

export function drillItems(db: Db, test: TestRow): DrillItem[] {
  const repeatedFrom = new Map(
    includedWords(db, test.id).map((word) => [word.id, word.repeated_from_title ?? null]),
  );

  return [...drillPayloads(db, test)].flatMap(([wordId, payload]) => {
    // stripAnswer is the only path from a question to a student, even for one
    // built on the fly — hand-rolling the shape is how an answer leaks.
    const safe = stripAnswer(payload);
    return safe.type === 'translate_input'
      ? [
          {
            wordId,
            prompt: safe.prompt,
            direction: safe.direction,
            repeatedFrom: repeatedFrom.get(wordId) ?? null,
            context: safe.context ?? null,
          },
        ]
      : [];
  });
}
