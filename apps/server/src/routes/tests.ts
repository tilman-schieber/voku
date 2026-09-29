import { Router, type Request } from 'express';
import {
  AcceptVariantSchema,
  CutoffSchema,
  DrillAnswerSchema,
  ExtractRequestSchema,
  ImportWordsSchema,
  RegenerateQuestionSchema,
  MixWeightsSchema,
  QuestionPayloadSchema,
  TestInputSchema,
  TestUpdateSchema,
  WordCreateSchema,
  WordPasteSchema,
  WordUpdateSchema,
  WorksheetRequestSchema,
  type DrillFeedback,
  type DrillView,
  type QuestionType,
} from '@voku/shared';
import { buildWorksheet, toCsv, toDocx } from '../services/worksheet.js';
import { drillChoice, drillItems, drillPayloads } from '../services/drill.js';
import { dueWords } from '../services/revision.js';
import { gradeAnswer } from '../services/grading.js';
import { badRequest, conflict, notFound, param, parseBody, route } from '../http.js';
import { requireTeacher } from '../middleware/auth.js';
import { getClass } from '../services/roster.js';
import {
  addWords,
  applyCutoff,
  createTest,
  difficultyForPosition,
  generateOffline,
  getTestRow,
  includedWords,
  listQuestions,
  listWords,
  parseWordPaste,
  replaceQuestions,
  setStatus,
  toTestView,
  type TestRow,
  type WordRow,
} from '../services/tests.js';
import { acceptVariant, rejectedAnswers, repeatCandidates } from '../services/regrade.js';
import { testStats } from '../services/stats.js';
import { activeJob, createJob, startJob } from '../services/jobs.js';
import { getLlmConfig, isLlmConfigured } from '../services/settings.js';
import {
  enrichWords,
  extractWords,
  generateWithLlm,
  regenerateOne,
  transcribeImages,
} from '../services/llm/compose.js';
import { TranscribeSchema } from '../services/llm/schemas.js';
import type { Db } from '../db/index.js';

export const testsRouter: Router = Router();
testsRouter.use(requireTeacher);

/** A test whose questions students may already have seen must not change under them. */
function assertEditable(test: TestRow): void {
  if (test.status === 'open') {
    throw conflict('Close the test before changing it — students are taking it right now.');
  }
}

/** Fails loudly and helpfully rather than pretending the AI button was a no-op. */
function requireLlm(db: Db): void {
  if (!isLlmConfigured(db)) {
    throw conflict('No language model is configured. Add one in Settings, or build the test by hand.');
  }
}

function wordOf(db: Db, testId: string, wordId: string): WordRow {
  const row = db.get<WordRow>('SELECT * FROM test_words WHERE id = :id AND test_id = :t', {
    id: wordId,
    t: testId,
  });
  if (!row) throw notFound('No such word in this test');
  return row;
}

testsRouter.get(
  '/',
  route((req, res) => {
    const classId = typeof req.query.classId === 'string' ? req.query.classId : null;
    const rows = req.db.all<TestRow>(
      `SELECT t.* FROM tests t
         JOIN classes c ON c.id = t.class_id
        WHERE c.teacher_id = :teacher ${classId ? 'AND t.class_id = :class' : ''}
        ORDER BY t.created_at DESC`,
      classId ? { teacher: req.teacher!.id, class: classId } : { teacher: req.teacher!.id },
    );
    res.json(rows.map((row) => toTestView(req.db, row)));
  }),
);

testsRouter.post(
  '/',
  route((req, res) => {
    const { classId, title } = parseBody(TestInputSchema, req.body);
    if (!getClass(req.db, req.teacher!.id, classId)) throw notFound('No such class');
    res.status(201).json(toTestView(req.db, createTest(req.db, classId, title)));
  }),
);

testsRouter.get(
  '/:id',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    res.json(toTestView(req.db, test));
  }),
);

testsRouter.patch(
  '/:id',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    const body = parseBody(TestUpdateSchema, req.body);

    // The title is cosmetic — renaming a running test cannot affect anyone's
    // attempt, so only the fields that shape the test itself are locked.
    const changesTheTest = Object.keys(body).some((key) => key !== 'title');
    if (changesTheTest) assertEditable(test);

    const sets: string[] = [];
    const params: Record<string, unknown> = { id: test.id };
    const set = (column: string, key: string, value: unknown) => {
      sets.push(`${column} = :${key}`);
      params[key] = value;
    };

    if (body.title !== undefined) set('title', 'title', body.title);
    if (body.sourceText !== undefined) set('source_text', 'source_text', body.sourceText);
    if (body.direction !== undefined) set('direction', 'direction', body.direction);
    if (body.durationSeconds !== undefined) set('duration_seconds', 'duration', body.durationSeconds);
    if (body.targetCount !== undefined) set('target_count', 'target', body.targetCount);
    if (body.mix !== undefined) set('mix_json', 'mix', JSON.stringify(MixWeightsSchema.parse(body.mix)));
    if (body.mcqAnyWord !== undefined) set('mcq_any_word', 'mcq_any', body.mcqAnyWord ? 1 : 0);

    if (sets.length > 0) {
      req.db.run(`UPDATE tests SET ${sets.join(', ')} WHERE id = :id`, params);
    }
    res.json(toTestView(req.db, req.db.get<TestRow>('SELECT * FROM tests WHERE id = :id', { id: test.id })!));
  }),
);

testsRouter.delete(
  '/:id',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    const attempts = req.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attempts WHERE test_id = :t AND mode = 'graded'`,
      { t: test.id },
    );
    if ((attempts?.n ?? 0) > 0) {
      throw conflict('Students have taken this test — deleting it would delete their results.');
    }
    req.db.run('DELETE FROM tests WHERE id = :id', { id: test.id });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Word list
// ---------------------------------------------------------------------------

testsRouter.get(
  '/:id/words',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    res.json(listWords(req.db, test.id));
  }),
);

testsRouter.post(
  '/:id/words',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    const body = parseBody(WordCreateSchema, req.body);
    const [created] = addWords(req.db, test.id, [{ ...body, origin: 'manual' }]);
    res.status(201).json(created);
  }),
);

testsRouter.post(
  '/:id/words/paste',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    const { text } = parseBody(WordPasteSchema, req.body);

    const pairs = parseWordPaste(text);
    if (pairs.length === 0) {
      throw badRequest(
        'No word pairs found. Use one pair per line, separated by a semicolon, a tab, or " - ".',
      );
    }

    const created = addWords(
      req.db,
      test.id,
      pairs.map((pair, i) => ({
        headwordEn: pair.en,
        translationDe: pair.de,
        // Pasted order is taken as difficulty order.
        difficulty: difficultyForPosition(i, pairs.length),
        origin: 'manual',
      })),
    );
    res.status(201).json({ added: created });
  }),
);

testsRouter.patch(
  '/:id/words/:wordId',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    const word = wordOf(req.db, test.id, param(req, 'wordId'));
    const body = parseBody(WordUpdateSchema, req.body);

    const sets: string[] = [];
    const params: Record<string, unknown> = { id: word.id };
    const set = (column: string, key: string, value: unknown) => {
      sets.push(`${column} = :${key}`);
      params[key] = value;
    };

    if (body.headwordEn !== undefined) set('headword_en', 'headword', body.headwordEn);
    if (body.translationDe !== undefined) set('translation_de', 'translation', body.translationDe);
    if (body.acceptedEn !== undefined) set('accepted_en_json', 'aen', JSON.stringify(body.acceptedEn));
    if (body.acceptedDe !== undefined) set('accepted_de_json', 'ade', JSON.stringify(body.acceptedDe));
    if (body.difficulty !== undefined) set('difficulty', 'difficulty', body.difficulty);
    if (body.trickiness !== undefined) set('trickiness', 'trickiness', body.trickiness);
    if (body.included !== undefined) set('included', 'included', body.included);
    // Blanked out rather than left empty, so "no definition" is one state, not two.
    if (body.definitionEn !== undefined) set('definition_en', 'definition', body.definitionEn || null);
    if (body.contextSentence !== undefined) set('context_sentence', 'context', body.contextSentence || null);

    if (sets.length > 0) req.db.run(`UPDATE test_words SET ${sets.join(', ')} WHERE id = :id`, params);
    res.json(listWords(req.db, test.id).find((w) => w.id === word.id));
  }),
);

testsRouter.delete(
  '/:id/words/:wordId',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    const word = wordOf(req.db, test.id, param(req, 'wordId'));
    req.db.run('DELETE FROM test_words WHERE id = :id', { id: word.id });
    res.status(204).end();
  }),
);

testsRouter.post(
  '/:id/cutoff',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    const { keep } = parseBody(CutoffSchema, req.body);
    const kept = applyCutoff(req.db, test.id, keep);
    res.json({ kept, words: listWords(req.db, test.id) });
  }),
);

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

testsRouter.post(
  '/:id/generate',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    const report = generateOffline(req.db, test);
    res.json({ report, questions: listQuestions(req.db, test.id) });
  }),
);

testsRouter.get(
  '/:id/questions',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    res.json({
      questions: listQuestions(req.db, test.id),
      report: test.report_json ? JSON.parse(test.report_json) : null,
    });
  }),
);

testsRouter.patch(
  '/:id/questions/:questionId',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    const questionId = param(req, 'questionId');
    const existing = req.db.get<{ id: string }>(
      'SELECT id FROM questions WHERE id = :id AND test_id = :t',
      { id: questionId, t: test.id },
    );
    if (!existing) throw notFound('No such question in this test');

    const payload = QuestionPayloadSchema.parse(req.body?.payload ?? req.body);
    req.db.run('UPDATE questions SET type = :type, payload_json = :payload WHERE id = :id', {
      type: payload.type,
      payload: JSON.stringify(payload),
      id: questionId,
    });
    res.json(listQuestions(req.db, test.id).find((q) => q.id === questionId));
  }),
);

testsRouter.delete(
  '/:id/questions/:questionId',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    const questionId = param(req, 'questionId');
    const row = req.db.get<{ word_id: string }>(
      'SELECT word_id FROM questions WHERE id = :id AND test_id = :t',
      { id: questionId, t: test.id },
    );
    if (!row) throw notFound('No such question in this test');

    // One question per word, so dropping the question drops the word from the
    // test. Excluded rather than deleted, so it can be put back.
    req.db.tx(() => {
      req.db.run('DELETE FROM questions WHERE id = :id', { id: questionId });
      req.db.run('UPDATE test_words SET included = 0 WHERE id = :id', { id: row.word_id });
      // Order index must stay contiguous for the sprint's position counter.
      const remaining = req.db.all<{ id: string }>(
        'SELECT id FROM questions WHERE test_id = :t ORDER BY order_index ASC',
        { t: test.id },
      );
      remaining.forEach((q, index) => {
        req.db.run('UPDATE questions SET order_index = :i WHERE id = :id', { i: index, id: q.id });
      });
    });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

for (const [path, status] of [
  ['publish', 'published'],
  ['unpublish', 'draft'],
  ['open', 'open'],
  ['close', 'closed'],
] as const) {
  testsRouter.post(
    `/:id/${path}`,
    route((req, res) => {
      const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
      res.json(toTestView(req.db, setStatus(req.db, test, status)));
    }),
  );
}

// ---------------------------------------------------------------------------
// Live board — the teacher's view of the room. Private by design: no ranking,
// nothing projectable, no behavioural data about how students are working.
// ---------------------------------------------------------------------------

testsRouter.get(
  '/:id/results',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));

    const rows = req.db
      .all<{
        student_id: string;
        student_name: string;
        attempt_id: string | null;
        submitted_at: string | null;
        deadline_at: string | null;
        reached_index: number | null;
        correct_count: number | null;
        target_snapshot: number | null;
      }>(
        `SELECT s.id AS student_id, s.name AS student_name,
                a.id AS attempt_id, a.submitted_at, a.deadline_at,
                a.reached_index, a.correct_count, a.target_snapshot
           FROM students s
           LEFT JOIN attempts a
             ON a.student_id = s.id AND a.test_id = :t AND a.mode = 'graded'
          WHERE s.class_id = :c AND s.archived_at IS NULL
          ORDER BY s.name COLLATE NOCASE`,
        { t: test.id, c: test.class_id },
      )
      .map((row) => {
        const target = row.target_snapshot ?? test.target_count;
        const remaining = row.deadline_at
          ? Math.max(0, Math.round((new Date(row.deadline_at).getTime() - Date.now()) / 1000))
          : null;
        return {
          studentId: row.student_id,
          studentName: row.student_name,
          attemptId: row.attempt_id,
          state: !row.attempt_id ? 'not_started' : row.submitted_at ? 'submitted' : 'in_progress',
          reachedIndex: row.reached_index ?? 0,
          correctCount: row.correct_count ?? 0,
          percent: target > 0 ? Math.round(((row.correct_count ?? 0) / target) * 100) : 0,
          secondsRemaining: row.submitted_at ? 0 : remaining,
        } satisfies import('@voku/shared').ResultRow;
      });

    const finished = rows.filter((r) => r.state === 'submitted');
    res.json({
      test: toTestView(req.db, test),
      rows,
      classAveragePercent:
        finished.length === 0
          ? null
          : Math.round(finished.reduce((sum, r) => sum + r.percent, 0) / finished.length),
    });
  }),
);

/** The escape hatch for "it glitched, sir" — wipes one student's attempt. */
testsRouter.post(
  '/:id/attempts/:attemptId/reset',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    const attemptId = param(req, 'attemptId');
    const attempt = req.db.get<{ id: string }>(
      'SELECT id FROM attempts WHERE id = :id AND test_id = :t',
      { id: attemptId, t: test.id },
    );
    if (!attempt) throw notFound('No such attempt for this test');

    // Answers cascade; the student starts clean with a fresh clock.
    req.db.run('DELETE FROM attempts WHERE id = :id', { id: attemptId });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// The AI composer. Every route here has a manual equivalent elsewhere, so a
// missing API key costs convenience, not the ability to run a test.
// ---------------------------------------------------------------------------

/** Whatever AI work is still running for this test, so the UI can rejoin it. */
testsRouter.get(
  '/:id/active-job',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    res.json({ job: activeJob(req.db, test.id) });
  }),
);

/** Reads text off a photographed textbook page or a PDF, into the paste box. */
testsRouter.post(
  '/:id/transcribe',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    requireLlm(req.db);
    const { images } = parseBody(TranscribeSchema, req.body);

    const jobId = createJob(req.db, 'transcribe', test.id, 1);
    startJob(req.db, jobId, async (report) => {
      const text = await transcribeImages(getLlmConfig(req.db), images);
      report.advance();
      return { text };
    });
    res.status(202).json({ jobId });
  }),
);

testsRouter.post(
  '/:id/extract-words',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    requireLlm(req.db);
    const { level, maxWords } = parseBody(ExtractRequestSchema, req.body);

    const jobId = createJob(req.db, 'extract', test.id, 1);
    startJob(req.db, jobId, async (report) => {
      const result = await extractWords(req.db, getLlmConfig(req.db), test, level, maxWords);
      report.advance();
      return result;
    });
    res.status(202).json({ jobId });
  }),
);

// ---------------------------------------------------------------------------
// Previewing the practice drill
//
// Deliberately without the students' `assertRevisable` guard: the point of the
// preview is to see what a class would get *before* deciding to publish, and a
// teacher looking at their own draft reveals nothing to anyone.
// ---------------------------------------------------------------------------

testsRouter.get(
  '/:id/drill',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    res.json({ title: test.title, items: drillItems(req.db, test) } satisfies DrillView);
  }),
);

testsRouter.get(
  '/:id/drill/:wordId/choice',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    const choice = drillChoice(req.db, test, param(req, 'wordId'));
    if (!choice) throw notFound('No such word in this test');
    res.json(choice);
  }),
);

testsRouter.post(
  '/:id/drill',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    const { wordId, given } = parseBody(DrillAnswerSchema, req.body);

    const payload = drillPayloads(req.db, test).get(wordId);
    if (!payload) throw notFound('No such word in this test');

    const grade = gradeAnswer(payload, given);
    res.json({
      correct: grade.correct,
      almost: grade.almost,
      correctAnswer: grade.correctAnswer,
    } satisfies DrillFeedback);
  }),
);

// ---------------------------------------------------------------------------
// The printed worksheet
// ---------------------------------------------------------------------------

function worksheetFor(req: Request, testId: string) {
  const test = getTestRow(req.db, req.teacher!.id, testId);
  const { variant } = parseBody(WorksheetRequestSchema, req.query);
  const cls = req.db.get<{ name: string }>('SELECT name FROM classes WHERE id = :id', {
    id: test.class_id,
  });
  return { test, view: buildWorksheet(req.db, test, cls?.name ?? '', variant) };
}

/** A filename the teacher can find again in a folder of thirty downloads. */
function worksheetFilename(title: string, variant: string, extension: string): string {
  const stem = title.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'worksheet';
  return `${stem}-${variant}.${extension}`;
}

testsRouter.get(
  '/:id/worksheet',
  route((req, res) => {
    res.json(worksheetFor(req, param(req, 'id')).view);
  }),
);

testsRouter.get(
  '/:id/worksheet.csv',
  route((req, res) => {
    const { view } = worksheetFor(req, param(req, 'id'));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="${worksheetFilename(view.title, view.variant, 'csv')}"`,
    );
    res.send(toCsv(view));
  }),
);

testsRouter.get(
  '/:id/worksheet.docx',
  route(async (req, res) => {
    const { view } = worksheetFor(req, param(req, 'id'));
    res.setHeader(
      'content-type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader(
      'content-disposition',
      `attachment; filename="${worksheetFilename(view.title, view.variant, 'docx')}"`,
    );
    res.send(await toDocx(view));
  }),
);

/** Fills in the definition and example the printed worksheet needs. */
testsRouter.post(
  '/:id/enrich-words',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    requireLlm(req.db);

    const jobId = createJob(req.db, 'enrich', test.id, 0);
    startJob(req.db, jobId, (report) => enrichWords(req.db, getLlmConfig(req.db), test, report));
    res.status(202).json({ jobId });
  }),
);

testsRouter.post(
  '/:id/generate-questions',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    requireLlm(req.db);

    const jobId = createJob(req.db, 'generate', test.id, 0);
    startJob(req.db, jobId, (report) => generateWithLlm(req.db, getLlmConfig(req.db), test, report));
    res.status(202).json({ jobId });
  }),
);

/** Rewrites one question, optionally as a different format. */
testsRouter.post(
  '/:id/questions/:questionId/regenerate',
  route(async (req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    const questionId = param(req, 'questionId');

    const row = req.db.get<{ word_id: string; order_index: number; type: QuestionType }>(
      'SELECT word_id, order_index, type FROM questions WHERE id = :id AND test_id = :t',
      { id: questionId, t: test.id },
    );
    if (!row) throw notFound('No such question in this test');

    const { type } = parseBody(RegenerateQuestionSchema, req.body ?? {});
    const nextType = type ?? row.type;
    if (nextType !== 'translate_input') requireLlm(req.db);

    const word = wordOf(req.db, test.id, row.word_id);
    const payload = await regenerateOne(
      req.db,
      getLlmConfig(req.db),
      test,
      word,
      nextType,
      row.order_index,
    );

    req.db.run('UPDATE questions SET type = :type, payload_json = :payload WHERE id = :id', {
      type: payload.type,
      payload: JSON.stringify(QuestionPayloadSchema.parse(payload)),
      id: questionId,
    });
    res.json(listQuestions(req.db, test.id).find((q) => q.id === questionId));
  }),
);

// ---------------------------------------------------------------------------
// After the test: bulk regrade, and carrying words into the next one
// ---------------------------------------------------------------------------

/** Which words the class did not know — the question a teacher asks next. */
testsRouter.get(
  '/:id/question-stats',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    res.json(testStats(req.db, test.id));
  }),
);

testsRouter.get(
  '/:id/rejected-answers',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    res.json(rejectedAnswers(req.db, test.id));
  }),
);

testsRouter.post(
  '/:id/accept-variant',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    const { questionId, variant, persist } = parseBody(AcceptVariantSchema, req.body);
    res.json(acceptVariant(req.db, test.id, questionId, variant, persist));
  }),
);

/** Earlier tests in the same class, newest first, as sources for repeat words. */
testsRouter.get(
  '/:id/repeat-sources',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    res.json(
      req.db.all(
        `SELECT id, title, status, closed_at AS closedAt FROM tests
          WHERE class_id = :c AND id != :id
          ORDER BY COALESCE(closed_at, created_at) DESC`,
        { c: test.class_id, id: test.id },
      ),
    );
  }),
);

/**
 * Words from earlier units that are due to come round again.
 *
 * A suggestion and nothing more — the teacher decides per test whether to take
 * any of them. Nothing is carried over automatically.
 */
testsRouter.get(
  '/:id/due-words',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    res.json(dueWords(req.db, test.class_id, test.id));
  }),
);

testsRouter.get(
  '/:id/repeat-candidates',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    const fromTestId = typeof req.query.fromTestId === 'string' ? req.query.fromTestId : null;
    if (!fromTestId) throw badRequest('Say which test to take the words from.');
    // Ownership check: the source must be in the same class.
    getTestRow(req.db, req.teacher!.id, fromTestId);
    res.json(repeatCandidates(req.db, fromTestId));
  }),
);

testsRouter.post(
  '/:id/import-words',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    assertEditable(test);
    const { fromTestId, wordIds } = parseBody(ImportWordsSchema, req.body);

    const placeholders = wordIds.map((_, i) => `:w${i}`).join(', ');
    const params: Record<string, unknown> = { class: test.class_id };
    wordIds.forEach((id, i) => (params[`w${i}`] = id));

    // Scoped to this teacher's own class rather than to one named test: the due
    // list draws from every earlier unit at once, so a single pick can span
    // several of them. Without `fromTestId` the source is read off each word.
    if (fromTestId) params.source = fromTestId;
    const rows = req.db.all<WordRow>(
      `SELECT w.* FROM test_words w
         JOIN tests t ON t.id = w.test_id
        WHERE t.class_id = :class
          AND t.id != :self
          ${fromTestId ? 'AND t.id = :source' : ''}
          AND w.id IN (${placeholders})`,
      { ...params, self: test.id },
    );
    if (rows.length === 0) throw notFound('None of those words are in an earlier test');

    const existing = new Set(
      req.db
        .all<{ headword_en: string }>('SELECT headword_en FROM test_words WHERE test_id = :t', {
          t: test.id,
        })
        .map((r) => r.headword_en.toLowerCase()),
    );

    const added = addWords(
      req.db,
      test.id,
      rows
        .filter((row) => !existing.has(row.headword_en.toLowerCase()))
        .map((row) => ({
          headwordEn: row.headword_en,
          translationDe: row.translation_de,
          pos: row.pos,
          difficulty: row.difficulty,
          trickiness: row.trickiness,
          trickinessKind: row.trickiness_kind,
          trickinessNote: row.trickiness_note,
          contextSentence: row.context_sentence,
          definitionEn: row.definition_en,
          acceptedEn: JSON.parse(row.accepted_en_json) as string[],
          acceptedDe: JSON.parse(row.accepted_de_json) as string[],
          suitsFillBlank: row.suits_fill_blank === 1,
          suitsDefinitionMcq: row.suits_definition_mcq === 1,
          origin: 'repeat',
          // Where it came back from, so the class can be told which unit.
          // A word repeated twice points at the unit it was last seen in.
          repeatedFrom: row.test_id,
        })),
    );

    res.status(201).json({ added, skipped: rows.length - added.length });
  }),
);

testsRouter.get(
  '/:id/study-list',
  route((req, res) => {
    const test = getTestRow(req.db, req.teacher!.id, param(req, 'id'));
    res.json(
      includedWords(req.db, test.id).map((w) => ({
        headwordEn: w.headword_en,
        translationDe: w.translation_de,
      })),
    );
  }),
);

export { replaceQuestions };
