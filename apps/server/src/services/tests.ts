import { randomUUID } from 'node:crypto';
import {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_MIX,
  DEFAULT_TARGET_RATIO,
  MixWeightsSchema,
  QuestionPayloadSchema,
  type AchievedMix,
  type MixWeights,
  type QuestionType,
  type QuestionView,
  type TestDirection,
  type TestStatus,
  type TestView,
  type WordView,
} from '@voku/shared';
import type { Db } from '../db/index.js';
import { json } from '../db/index.js';
import { conflict, notFound } from '../http.js';
import { assignFormats, type AssignableWord } from './assign.js';
import { buildOffline, type BuildableWord } from './build-questions.js';
import { makeRng, seedFrom } from './rng.js';

export interface TestRow {
  id: string;
  class_id: string;
  title: string;
  status: TestStatus;
  source_text: string;
  direction: TestDirection;
  duration_seconds: number;
  target_count: number;
  mix_json: string;
  /** 0/1: whether multiple choice may go to any word in this test. */
  mcq_any_word: number;
  report_json: string | null;
  created_at: string;
  published_at: string | null;
  opened_at: string | null;
  closed_at: string | null;
}

export interface WordRow {
  id: string;
  test_id: string;
  headword_en: string;
  translation_de: string;
  pos: string | null;
  difficulty: number;
  trickiness: number;
  trickiness_kind: string;
  trickiness_note: string | null;
  context_sentence: string | null;
  definition_en: string | null;
  accepted_en_json: string;
  accepted_de_json: string;
  suits_fill_blank: number;
  suits_definition_mcq: number;
  included: number;
  origin: string;
  repeated_from: string | null;
  /** Joined in, so a deleted source test simply drops the label. */
  repeated_from_title?: string | null;
  sort_rank: number;
}

export interface QuestionRow {
  id: string;
  test_id: string;
  word_id: string;
  type: QuestionType;
  payload_json: string;
  order_index: number;
}

export function defaultTargetFor(poolSize: number): number {
  return Math.max(1, Math.round(poolSize * DEFAULT_TARGET_RATIO));
}

export function toWordView(row: WordRow): WordView {
  return {
    id: row.id,
    headwordEn: row.headword_en,
    translationDe: row.translation_de,
    pos: row.pos,
    difficulty: row.difficulty,
    trickiness: row.trickiness,
    trickinessKind: row.trickiness_kind as WordView['trickinessKind'],
    trickinessNote: row.trickiness_note,
    contextSentence: row.context_sentence,
    definitionEn: row.definition_en,
    acceptedEn: json<string[]>(row.accepted_en_json, []),
    acceptedDe: json<string[]>(row.accepted_de_json, []),
    suitsFillBlank: row.suits_fill_blank === 1,
    suitsDefinitionMcq: row.suits_definition_mcq === 1,
    included: row.included === 1,
    origin: row.origin as WordView['origin'],
    repeatedFrom:
      row.repeated_from && row.repeated_from_title
        ? { testId: row.repeated_from, title: row.repeated_from_title }
        : null,
    rank: row.sort_rank,
  };
}

/** Every read of a word carries the source test's name, for the "from Unit 3" label. */
const WORD_SELECT = `SELECT w.*, src.title AS repeated_from_title
     FROM test_words w
     LEFT JOIN tests src ON src.id = w.repeated_from`;

export function toTestView(db: Db, row: TestRow): TestView {
  const counts = db.get<{ words: number; included: number; questions: number; class_name: string }>(
    `SELECT
       (SELECT COUNT(*) FROM test_words w WHERE w.test_id = :id)                  AS words,
       (SELECT COUNT(*) FROM test_words w WHERE w.test_id = :id AND w.included=1) AS included,
       (SELECT COUNT(*) FROM questions q WHERE q.test_id = :id)                   AS questions,
       (SELECT c.name FROM classes c WHERE c.id = :class)                         AS class_name`,
    { id: row.id, class: row.class_id },
  )!;

  const mix = MixWeightsSchema.safeParse(json<unknown>(row.mix_json, {}));

  return {
    id: row.id,
    classId: row.class_id,
    className: counts.class_name,
    title: row.title,
    status: row.status,
    sourceText: row.source_text,
    direction: row.direction,
    durationSeconds: row.duration_seconds,
    targetCount: row.target_count,
    mix: mix.success ? mix.data : DEFAULT_MIX,
    mcqAnyWord: row.mcq_any_word === 1,
    wordCount: counts.words,
    includedCount: counts.included,
    questionCount: counts.questions,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

export function getTestRow(db: Db, teacherId: string, testId: string): TestRow {
  const row = db.get<TestRow>(
    `SELECT t.* FROM tests t
       JOIN classes c ON c.id = t.class_id
      WHERE t.id = :id AND c.teacher_id = :teacher`,
    { id: testId, teacher: teacherId },
  );
  if (!row) throw notFound('No such test');
  return row;
}

export function createTest(db: Db, classId: string, title: string): TestRow {
  const id = randomUUID();
  db.run(
    `INSERT INTO tests (id, class_id, title, status, source_text, direction,
                        duration_seconds, target_count, mix_json, created_at)
     VALUES (:id, :class_id, :title, 'draft', '', 'de_en',
             :duration, :target, :mix, :created_at)`,
    {
      id,
      class_id: classId,
      title,
      duration: DEFAULT_DURATION_SECONDS,
      target: DEFAULT_TARGET_RATIO * 40,
      mix: JSON.stringify(DEFAULT_MIX),
      created_at: new Date().toISOString(),
    },
  );
  return db.get<TestRow>('SELECT * FROM tests WHERE id = :id', { id })!;
}

// ---------------------------------------------------------------------------
// Word list
// ---------------------------------------------------------------------------

/**
 * Accepts what a teacher actually has to hand: a glossary column pasted out of
 * Excel (tab), a semicolon list, or `english - german`. First separator found
 * on a line wins, so a German translation containing a hyphen still works.
 */
export function parseWordPaste(text: string): Array<{ en: string; de: string }> {
  const out: Array<{ en: string; de: string }> = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = /^(.*?)\s*(?:\t|;|=|\s[-–—]\s)\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    const en = match[1]!.trim();
    const de = match[2]!.trim();
    if (!en || !de) continue;

    const key = en.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ en, de });
  }
  return out;
}

/** Paste order is difficulty order, spread across the 1–10 scale. */
export function difficultyForPosition(index: number, total: number): number {
  if (total <= 1) return 5;
  return Math.min(10, Math.max(1, Math.round(1 + (index / (total - 1)) * 9)));
}

export interface NewWord {
  headwordEn: string;
  translationDe: string;
  pos?: string | null;
  difficulty: number;
  trickiness?: number;
  trickinessKind?: string;
  trickinessNote?: string | null;
  contextSentence?: string | null;
  definitionEn?: string | null;
  acceptedEn?: string[];
  acceptedDe?: string[];
  suitsFillBlank?: boolean;
  suitsDefinitionMcq?: boolean;
  origin?: string;
  /** The test this word was carried over from, when it is a repeat. */
  repeatedFrom?: string | null;
}

export function addWords(db: Db, testId: string, words: NewWord[]): WordView[] {
  const startRank =
    db.get<{ n: number }>('SELECT COALESCE(MAX(sort_rank), -1) + 1 AS n FROM test_words WHERE test_id = :t', {
      t: testId,
    })?.n ?? 0;

  const created: WordView[] = [];
  db.tx(() => {
    words.forEach((word, i) => {
      const id = randomUUID();
      db.run(
        `INSERT INTO test_words (
           id, test_id, headword_en, translation_de, pos, difficulty, trickiness,
           trickiness_kind, trickiness_note, context_sentence, definition_en,
           accepted_en_json, accepted_de_json, suits_fill_blank, suits_definition_mcq,
           included, origin, repeated_from, sort_rank)
         VALUES (
           :id, :test_id, :headword_en, :translation_de, :pos, :difficulty, :trickiness,
           :trickiness_kind, :trickiness_note, :context_sentence, :definition_en,
           :accepted_en, :accepted_de, :suits_fill_blank, :suits_definition_mcq,
           1, :origin, :repeated_from, :sort_rank)`,
        {
          id,
          test_id: testId,
          headword_en: word.headwordEn,
          translation_de: word.translationDe,
          pos: word.pos ?? null,
          difficulty: word.difficulty,
          trickiness: word.trickiness ?? 0,
          trickiness_kind: word.trickinessKind ?? 'none',
          trickiness_note: word.trickinessNote ?? null,
          context_sentence: word.contextSentence ?? null,
          definition_en: word.definitionEn ?? null,
          accepted_en: JSON.stringify(word.acceptedEn ?? []),
          accepted_de: JSON.stringify(word.acceptedDe ?? []),
          suits_fill_blank: word.suitsFillBlank ?? true,
          suits_definition_mcq: word.suitsDefinitionMcq ?? true,
          origin: word.origin ?? 'manual',
          repeated_from: word.repeatedFrom ?? null,
          sort_rank: startRank + i,
        },
      );
      created.push(toWordView(db.get<WordRow>(`${WORD_SELECT} WHERE w.id = :id`, { id })!));
    });
  });
  return created;
}

export function listWords(db: Db, testId: string): WordView[] {
  return db
    .all<WordRow>(
      `${WORD_SELECT}
        WHERE w.test_id = :t
        ORDER BY w.difficulty DESC, w.sort_rank ASC, w.id ASC`,
      { t: testId },
    )
    .map(toWordView);
}

/** Keep the N hardest words, drop the rest from the test without deleting them. */
export function applyCutoff(db: Db, testId: string, keep: number): number {
  const ordered = db.all<{ id: string }>(
    `SELECT id FROM test_words WHERE test_id = :t
      ORDER BY difficulty DESC, trickiness DESC, sort_rank ASC, id ASC`,
    { t: testId },
  );
  const keepIds = new Set(ordered.slice(0, keep).map((r) => r.id));

  db.tx(() => {
    for (const row of ordered) {
      db.run('UPDATE test_words SET included = :inc WHERE id = :id', {
        inc: keepIds.has(row.id),
        id: row.id,
      });
    }
  });
  return keepIds.size;
}

export function includedWords(db: Db, testId: string): WordRow[] {
  // Ascending difficulty: this is the order the sprint runs in.
  return db.all<WordRow>(
    `${WORD_SELECT}
      WHERE w.test_id = :t AND w.included = 1
      ORDER BY w.difficulty ASC, w.sort_rank ASC, w.id ASC`,
    { t: testId },
  );
}

export function toAssignable(row: WordRow): AssignableWord {
  return {
    id: row.id,
    difficulty: row.difficulty,
    trickiness: row.trickiness,
    suitsFillBlank: row.suits_fill_blank === 1,
    suitsDefinitionMcq: row.suits_definition_mcq === 1,
  };
}

export function toBuildable(row: WordRow): BuildableWord {
  return {
    id: row.id,
    headwordEn: row.headword_en,
    translationDe: row.translation_de,
    acceptedEn: json<string[]>(row.accepted_en_json, []),
    acceptedDe: json<string[]>(row.accepted_de_json, []),
    contextSentence: row.context_sentence,
    difficulty: row.difficulty,
  };
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export function listQuestions(db: Db, testId: string): QuestionView[] {
  return db
    .all<QuestionRow & { headword_en: string }>(
      `SELECT q.*, w.headword_en FROM questions q
         JOIN test_words w ON w.id = q.word_id
        WHERE q.test_id = :t
        ORDER BY q.order_index ASC`,
      { t: testId },
    )
    .map((row) => ({
      id: row.id,
      wordId: row.word_id,
      headwordEn: row.headword_en,
      type: row.type,
      payload: QuestionPayloadSchema.parse(JSON.parse(row.payload_json)),
      orderIndex: row.order_index,
    }));
}

export interface PersistableQuestion {
  wordId: string;
  type: QuestionType;
  payload: unknown;
}

/**
 * Replaces the whole question set. Order index follows the difficulty order of
 * the words, which is the order the sprint presents them in — identical for
 * every student, so position 12 is the same question for the whole class.
 */
export function replaceQuestions(
  db: Db,
  testId: string,
  wordOrder: WordRow[],
  questions: PersistableQuestion[],
): number {
  const position = new Map(wordOrder.map((w, i) => [w.id, i]));
  const ordered = [...questions].sort(
    (a, b) => (position.get(a.wordId) ?? 0) - (position.get(b.wordId) ?? 0),
  );

  db.tx(() => {
    db.run('DELETE FROM questions WHERE test_id = :t', { t: testId });
    ordered.forEach((question, index) => {
      // Parse before writing: a malformed payload must never reach the database.
      const payload = QuestionPayloadSchema.parse(question.payload);
      db.run(
        `INSERT INTO questions (id, test_id, word_id, type, payload_json, order_index)
         VALUES (:id, :test_id, :word_id, :type, :payload, :order_index)`,
        {
          id: randomUUID(),
          test_id: testId,
          word_id: question.wordId,
          type: payload.type,
          payload: JSON.stringify(payload),
          order_index: index,
        },
      );
    });
  });
  return ordered.length;
}

/** Builds the whole question set from local data only — no language model. */
export function generateOffline(db: Db, test: TestRow): AchievedMix {
  const words = includedWords(db, test.id);
  if (words.length === 0) throw conflict('Add some words before generating questions.');

  const mix = MixWeightsSchema.safeParse(json<unknown>(test.mix_json, {}));
  const { assignments, report } = assignFormats(
    words.map(toAssignable),
    mix.success ? mix.data : DEFAULT_MIX,
    { anyWord: test.mcq_any_word === 1 },
  );

  const byWord = new Map(assignments.map((a) => [a.wordId, a.type]));
  const orderedAssignments = words.map((w) => ({
    wordId: w.id,
    type: byWord.get(w.id) ?? ('translate_input' as QuestionType),
  }));

  const built = buildOffline(words.map(toBuildable), orderedAssignments, {
    direction: test.direction,
    rng: makeRng(seedFrom(test.id)),
  });

  replaceQuestions(db, test.id, words, built);

  // A downgrade is a shortfall too — the teacher asked for a format the local
  // data could not produce, and should be told rather than left to notice.
  const achieved = { ...report.achieved };
  const downgrades = new Map<QuestionType, number>();
  for (const q of built) {
    if (!q.downgradedFrom) continue;
    downgrades.set(q.downgradedFrom, (downgrades.get(q.downgradedFrom) ?? 0) + 1);
  }
  for (const [type, count] of downgrades) {
    achieved[type] -= count;
    achieved.translate_input += count;
  }

  const finalReport: AchievedMix = {
    ...report,
    achieved,
    shortfalls: [
      ...report.shortfalls,
      ...[...downgrades].map(([type, count]) => ({
        type,
        wanted: report.achieved[type],
        got: report.achieved[type] - count,
        reason:
          type === 'mcq_definition'
            ? 'an English definition has to be written — connect a language model, or write these by hand'
            : type === 'fill_blank'
              ? 'no sentence was available to turn into a gap for these words'
              : 'not enough other words to build believable options',
      })),
    ],
  };

  db.run('UPDATE tests SET report_json = :report WHERE id = :id', {
    report: JSON.stringify(finalReport),
    id: test.id,
  });
  return finalReport;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const ALLOWED: Record<TestStatus, TestStatus[]> = {
  draft: ['published', 'open'],
  published: ['draft', 'open'],
  // Re-opening a closed test lets a student who missed the lesson sit it.
  open: ['closed'],
  closed: ['open'],
};

export function setStatus(db: Db, test: TestRow, next: TestStatus): TestRow {
  if (test.status === next) return test;
  if (!ALLOWED[test.status].includes(next)) {
    throw conflict(`A ${test.status} test cannot go straight to ${next}.`);
  }

  if (next === 'published' || next === 'open') {
    const included = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM test_words WHERE test_id = :t AND included = 1',
      { t: test.id },
    );
    if ((included?.n ?? 0) === 0) throw conflict('Add at least one word first.');
  }

  if (next === 'open') {
    const pool =
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM questions WHERE test_id = :t', { t: test.id })
        ?.n ?? 0;
    if (pool === 0) throw conflict('Generate the questions first.');
    // The whole point of the format is that the score can pass 100%. A pool no
    // bigger than the target caps everyone at 100 and removes the incentive.
    if (pool <= test.target_count) {
      throw conflict(
        `This test has ${pool} questions but the target is ${test.target_count}, so nobody could score above 100%. Add more words or lower the target.`,
      );
    }
  }

  const now = new Date().toISOString();
  const stamp =
    next === 'published'
      ? 'published_at = :now'
      : next === 'open'
        ? 'opened_at = :now, closed_at = NULL'
        : next === 'closed'
          ? 'closed_at = :now'
          : 'published_at = NULL';

  db.run(`UPDATE tests SET status = :status, ${stamp} WHERE id = :id`, {
    status: next,
    now,
    id: test.id,
  });

  if (next === 'closed') submitInFlightAttempts(db, test.id, now);

  return db.get<TestRow>('SELECT * FROM tests WHERE id = :id', { id: test.id })!;
}

/** Closing the test ends everyone's sprint, including anyone still typing. */
export function submitInFlightAttempts(db: Db, testId: string, at: string): number {
  return db.run(
    `UPDATE attempts SET submitted_at = :at
      WHERE test_id = :t AND mode = 'graded' AND submitted_at IS NULL`,
    { at, t: testId },
  ).changes;
}
