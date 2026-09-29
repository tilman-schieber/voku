import {
  stripAnswer,
  type DrillChoice,
  type DrillItem,
  type MyWord,
  type MyWordsView,
  type QuestionPayload,
} from '@voku/shared';
import type { Db } from '../db/index.js';
import { drillChoice, drillPayloads } from './drill.js';
import type { TestRow } from './tests.js';

/**
 * A student's own words to work on: the ones they got wrong in a test, gathered
 * across every unit.
 *
 * Nothing new is collected. Every answer is already kept, for the review screen
 * and the bulk regrade; this only reads a student's own answers back to them.
 * It is never shown to the teacher, who already sees how the class did per word
 * and has no need of a per-child list of failures.
 *
 * The rules, each chosen on purpose:
 *
 * - Only graded attempts. Practice is not measurement, and is not stored anyway.
 * - Only closed tests. While a test is open, a student who handed in early would
 *   be holding the answers to questions their classmates are still writing.
 * - Only questions they reached. Not getting to word 35 in five minutes is not
 *   the same as getting it wrong — the same rule the class statistics use.
 * - The most recent answer decides. A word got right in a later unit, usually
 *   because the teacher brought it back, leaves the list. Practising alone does
 *   not clear it: practice is deliberately not remembered, so the test is where
 *   a word is shown to be known.
 */

/** The practice round draws on the most-missed words first, and stops here. */
const DRILL_LIMIT = 20;

interface AnswerRow {
  word_id: string;
  headword_en: string;
  translation_de: string;
  test_id: string;
  test_title: string;
  is_correct: number;
}

interface Tally {
  latest: AnswerRow;
  missed: number;
}

function tallies(db: Db, studentId: string): Map<string, Tally> {
  const rows = db.all<AnswerRow>(
    `SELECT w.id           AS word_id,
            w.headword_en,
            w.translation_de,
            t.id           AS test_id,
            t.title        AS test_title,
            a.is_correct
       FROM answers a
       JOIN attempts at2  ON at2.id = a.attempt_id
                         AND at2.mode = 'graded'
                         AND at2.student_id = :student
       JOIN questions q   ON q.id = a.question_id
       JOIN test_words w  ON w.id = q.word_id
       JOIN tests t       ON t.id = w.test_id AND t.status = 'closed'
      ORDER BY a.answered_at DESC, a.id DESC`,
    { student: studentId },
  );

  // Keyed on the word itself, not the row: a word brought back into a later
  // unit is a new row there, but it is the same word to the student.
  const byWord = new Map<string, Tally>();
  for (const row of rows) {
    const key = row.headword_en.toLowerCase();
    const tally = byWord.get(key);
    // Rows arrive newest first, so the first one seen is the latest answer.
    if (!tally) byWord.set(key, { latest: row, missed: row.is_correct ? 0 : 1 });
    else if (!row.is_correct) tally.missed += 1;
  }
  return byWord;
}

export function myWords(db: Db, studentId: string): MyWordsView {
  const words: MyWord[] = [];
  let cleared = 0;

  for (const { latest, missed } of tallies(db, studentId).values()) {
    if (latest.is_correct) {
      // Missed once, right since: that is the list working.
      if (missed > 0) cleared += 1;
      continue;
    }
    words.push({
      wordId: latest.word_id,
      headwordEn: latest.headword_en,
      translationDe: latest.translation_de,
      fromTestTitle: latest.test_title,
      timesMissed: missed,
    });
  }

  // Most-missed first; ties keep the newest miss first, as the rows arrived.
  words.sort((a, b) => b.timesMissed - a.timesMissed);
  return { words, cleared };
}

/**
 * Where each listed word can be drilled from. Asked the way that word's own unit
 * asks it in practice, so it is the same question the student already knows.
 */
function sources(db: Db, studentId: string): Map<string, { test: TestRow; payload: QuestionPayload; from: string }> {
  const out = new Map<string, { test: TestRow; payload: QuestionPayload; from: string }>();
  const cache = new Map<string, { test: TestRow; payloads: Map<string, QuestionPayload> }>();

  const listed = myWords(db, studentId).words.slice(0, DRILL_LIMIT);
  for (const word of listed) {
    const testId = db.get<{ test_id: string }>('SELECT test_id FROM test_words WHERE id = :id', {
      id: word.wordId,
    })?.test_id;
    if (!testId) continue;

    let entry = cache.get(testId);
    if (!entry) {
      const test = db.get<TestRow>('SELECT * FROM tests WHERE id = :id', { id: testId })!;
      entry = { test, payloads: drillPayloads(db, test) };
      cache.set(testId, entry);
    }
    // A word taken out of its unit afterwards has no practice question; skip it.
    const payload = entry.payloads.get(word.wordId);
    if (payload) out.set(word.wordId, { test: entry.test, payload, from: word.fromTestTitle });
  }
  return out;
}

export function myWordsDrill(db: Db, studentId: string): DrillItem[] {
  return [...sources(db, studentId)].flatMap(([wordId, { payload, from }]) => {
    const safe = stripAnswer(payload);
    return safe.type === 'translate_input'
      ? [
          {
            wordId,
            prompt: safe.prompt,
            direction: safe.direction,
            repeatedFrom: from,
            context: safe.context ?? null,
          },
        ]
      : [];
  });
}

/** Only words on the student's own list can be drilled or marked through here. */
export function myWordPayload(db: Db, studentId: string, wordId: string): QuestionPayload | null {
  return sources(db, studentId).get(wordId)?.payload ?? null;
}

export function myWordChoice(db: Db, studentId: string, wordId: string): DrillChoice | null {
  const source = sources(db, studentId).get(wordId);
  return source ? drillChoice(db, source.test, wordId) : null;
}
