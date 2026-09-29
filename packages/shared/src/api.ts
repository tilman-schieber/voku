import { z } from 'zod';
import {
  CefrLevelSchema,
  MixWeightsSchema,
  TestStatusSchema,
  TrickinessKindSchema,
  WordOriginSchema,
  type AchievedMix,
  type AttemptMode,
} from './domain.js';
import {
  QuestionTypeSchema,
  TestDirectionSchema,
  type QuestionDirection,
  type QuestionPayload,
  type QuestionType,
  type StudentQuestionPayload,
} from './questions.js';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const LoginRequestSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
});

export const ClassInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const ClassUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  archived: z.boolean().optional(),
});

/** One name per line. Blank lines and duplicates within the paste are dropped. */
export const BulkStudentsSchema = z.object({
  names: z.string().min(1),
});

export const StudentUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  archived: z.boolean().optional(),
});

export const TestInputSchema = z.object({
  classId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
});

export const TestUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  sourceText: z.string().optional(),
  direction: TestDirectionSchema.optional(),
  durationSeconds: z.number().int().min(30).max(3600).optional(),
  targetCount: z.number().int().min(1).optional(),
  mix: MixWeightsSchema.optional(),
  mcqAnyWord: z.boolean().optional(),
});

export const ExtractRequestSchema = z.object({
  level: CefrLevelSchema.default('B1'),
  maxWords: z.number().int().min(5).max(200).default(80),
});

/**
 * Accepts `english;german`, `english<TAB>german`, or `english - german`,
 * one pair per line. Order of the paste is taken as difficulty order.
 */
export const WordPasteSchema = z.object({
  text: z.string().min(1),
});

export const WordUpdateSchema = z.object({
  headwordEn: z.string().trim().min(1).optional(),
  translationDe: z.string().trim().min(1).optional(),
  acceptedEn: z.array(z.string().trim().min(1)).optional(),
  acceptedDe: z.array(z.string().trim().min(1)).optional(),
  difficulty: z.number().int().min(1).max(10).optional(),
  trickiness: z.number().int().min(0).max(3).optional(),
  included: z.boolean().optional(),
  /** Empty string clears the field — that is how the teacher rejects a bad one. */
  definitionEn: z.string().trim().max(400).optional(),
  contextSentence: z.string().trim().max(400).optional(),
});

export const WordCreateSchema = z.object({
  headwordEn: z.string().trim().min(1),
  translationDe: z.string().trim().min(1),
  difficulty: z.number().int().min(1).max(10).default(5),
  trickiness: z.number().int().min(0).max(3).default(0),
  trickinessKind: TrickinessKindSchema.default('none'),
  contextSentence: z.string().trim().optional(),
  definitionEn: z.string().trim().optional(),
});

/** Keep the N most difficult included words, exclude the rest. */
export const CutoffSchema = z.object({
  keep: z.number().int().min(1),
});

/**
 * What the printed sheet leaves for the student to supply.
 *
 * `full` is the sheet to learn from; the other three each remove one thing and
 * ask for it back. The variant decides the content, not the file format, so all
 * of them print, download as a table, and open in Word identically.
 */
export const WorksheetVariantSchema = z.enum(['full', 'no_german', 'gapped', 'compact']);
export type WorksheetVariant = z.infer<typeof WorksheetVariantSchema>;

export const WorksheetRequestSchema = z.object({
  variant: WorksheetVariantSchema.default('full'),
});

export const ImportWordsSchema = z.object({
  /** Optional: the due list spans several earlier units, so words carry their own source. */
  fromTestId: z.string().min(1).optional(),
  wordIds: z.array(z.string().min(1)).min(1),
});

export const GenerateRequestSchema = z.object({
  /** Regenerate everything, discarding questions already reviewed. */
  force: z.boolean().default(false),
});

export const RegenerateQuestionSchema = z.object({
  type: QuestionTypeSchema.optional(),
});

export const AnswerSubmitSchema = z.object({
  questionId: z.string().min(1),
  /** Free text for typed formats; the option index as a string for MCQ. */
  given: z.string(),
});

export const StudentSessionSchema = z.object({
  token: z.string().min(1),
});

export const DrillAnswerSchema = z.object({
  wordId: z.string().min(1),
  given: z.string(),
});

export const AcceptVariantSchema = z.object({
  questionId: z.string().min(1),
  variant: z.string().min(1),
  /** Also add it to the word's permanent alternatives, so it carries to future tests. */
  persist: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ClassView {
  id: string;
  name: string;
  studentCount: number;
  testCount: number;
  createdAt: string;
  archivedAt: string | null;
}

export interface StudentView {
  id: string;
  classId: string;
  name: string;
  token: string;
  loginUrl: string;
  archivedAt: string | null;
}

export interface TestView {
  id: string;
  classId: string;
  className: string;
  title: string;
  status: z.infer<typeof TestStatusSchema>;
  sourceText: string;
  direction: z.infer<typeof TestDirectionSchema>;
  durationSeconds: number;
  targetCount: number;
  mix: z.infer<typeof MixWeightsSchema>;
  /** Multiple choice may go to any word, not only traps and the harder ones. */
  mcqAnyWord: boolean;
  wordCount: number;
  includedCount: number;
  questionCount: number;
  createdAt: string;
  publishedAt: string | null;
  openedAt: string | null;
  closedAt: string | null;
}

export interface WordView {
  id: string;
  headwordEn: string;
  translationDe: string;
  pos: string | null;
  difficulty: number;
  trickiness: number;
  trickinessKind: z.infer<typeof TrickinessKindSchema>;
  trickinessNote: string | null;
  contextSentence: string | null;
  definitionEn: string | null;
  acceptedEn: string[];
  acceptedDe: string[];
  suitsFillBlank: boolean;
  suitsDefinitionMcq: boolean;
  included: boolean;
  origin: z.infer<typeof WordOriginSchema>;
  /** Set when the word was carried over; null for a word first seen here. */
  repeatedFrom: RepeatedFrom | null;
  rank: number;
}

/**
 * One line of the printed sheet. Blanking has already happened, so every
 * renderer — the print page, the CSV, the Word file — prints what it is given
 * and cannot disagree with the others about what the student may see.
 */
export interface WorksheetRow {
  word: string;
  german: string;
  definition: string;
  example: string;
  /** "from Unit 3" for a carried-over word, empty for a new one. */
  from: string;
}

export interface WorksheetView {
  title: string;
  className: string;
  variant: WorksheetVariant;
  /** Columns to print, in order — a compact sheet has no definition column at all. */
  columns: Array<keyof WorksheetRow>;
  rows: WorksheetRow[];
}

/** Teacher-facing: includes the answer. */
export interface QuestionView {
  id: string;
  wordId: string;
  headwordEn: string;
  type: QuestionType;
  payload: QuestionPayload;
  orderIndex: number;
}

/** Student-facing: the answer has been through stripAnswer(). */
export interface StudentQuestionView {
  id: string;
  index: number;
  total: number;
  payload: StudentQuestionPayload;
}

/**
 * Practising the word list before the test.
 *
 * Deliberately not an attempt: nothing is stored, nothing is scored, and the
 * teacher is never told who practised. It drills the word pairs rather than the
 * test's own questions, so revising cannot become a rehearsal of the exact
 * items — see the practice decision in CLAUDE.md.
 */
export interface DrillItem {
  wordId: string;
  prompt: string;
  direction: QuestionDirection;
  /** The unit this word came back from, shown as a quiet label. Null if new. */
  repeatedFrom: string | null;
  /** The sentence the word was met in — blanked when it would give the answer. */
  context: string | null;
}

export interface DrillView {
  title: string;
  items: DrillItem[];
}

/** A word a student got wrong in a test and has not got right since. */
export interface MyWord {
  wordId: string;
  headwordEn: string;
  translationDe: string;
  /** The unit where it was last missed. */
  fromTestTitle: string;
  timesMissed: number;
}

/** A student's own words to work on — shown to them, never to the teacher. */
export interface MyWordsView {
  words: MyWord[];
  /** Words once missed and answered correctly in a test since. */
  cleared: number;
}

/**
 * The same word offered as a choice, for a second attempt after a miss.
 *
 * Built from the other words on the list, never from the test's own multiple
 * choice — those carry the traps the model wrote, and seeing them in practice
 * would spend them before the test.
 */
export interface DrillChoice {
  wordId: string;
  prompt: string;
  direction: QuestionDirection;
  /** Empty when the list is too short, or too full of synonyms, for a fair choice. */
  options: string[];
}

export interface DrillFeedback {
  correct: boolean;
  /** Wrong by one letter — shows the right spelling without softening the mark. */
  almost: boolean;
  correctAnswer: string;
}

export interface AnswerFeedback {
  correct: boolean;
  correctAnswer: string;
  /** Set when the answer was a near miss — shown as "Almost — receive", scored wrong. */
  almost: boolean;
  correctCount: number;
  percent: number;
}

export interface AttemptView {
  id: string;
  testId: string;
  testTitle: string;
  mode: AttemptMode;
  startedAt: string;
  deadlineAt: string | null;
  submittedAt: string | null;
  serverNow: string;
  secondsRemaining: number | null;
  reachedIndex: number;
  correctCount: number;
  targetCount: number;
  percent: number;
  poolSize: number;
  /** The answers can be gone through — only once the teacher has closed the test. */
  reviewOpen: boolean;
}

export interface StudentHomeView {
  student: { id: string; name: string };
  className: string;
  openTests: Array<{ id: string; title: string; durationSeconds: number; attemptId: string | null; submitted: boolean }>;
  studyLists: Array<{ id: string; title: string; wordCount: number }>;
  pastAttempts: Array<{ attemptId: string; testId: string; testTitle: string; percent: number; correctCount: number; targetCount: number; submittedAt: string }>;
  /** A test in the class is running, so every list and practice is paused. */
  revisionPaused: boolean;
}

export interface ResultRow {
  studentId: string;
  studentName: string;
  attemptId: string | null;
  state: 'not_started' | 'in_progress' | 'submitted';
  reachedIndex: number;
  correctCount: number;
  percent: number;
  secondsRemaining: number | null;
}

export interface ResultsView {
  test: TestView;
  rows: ResultRow[];
  classAveragePercent: number | null;
}

export interface RejectedAnswerGroup {
  questionId: string;
  headwordEn: string;
  correctAnswer: string;
  variant: string;
  count: number;
  studentNames: string[];
}

/**
 * A word from an earlier unit that is due to come round again.
 *
 * `dueInDays` counts down to nought and then goes negative: -12 means twelve
 * days past due. Judged for the class, never for one student — working out what
 * one child is individually due would mean following them for months, and this
 * app stores a first name and a score on purpose.
 */
export interface DueWord {
  wordId: string;
  headwordEn: string;
  translationDe: string;
  fromTestId: string;
  fromTestTitle: string;
  testedAt: string;
  daysSince: number;
  /** How many closed tests in this class have carried the word. */
  timesTested: number;
  /** Correct rate among the students who reached it last time; null if nobody did. */
  correctRate: number | null;
  dueInDays: number;
}

/** Where a repeated word came from, for the quiet "from Unit 3" label. */
export interface RepeatedFrom {
  testId: string;
  title: string;
}

export interface RepeatCandidate {
  wordId: string;
  headwordEn: string;
  translationDe: string;
  difficulty: number;
  /** Correct rate among students who actually reached the question. Null if nobody did. */
  correctRate: number | null;
  reachedCount: number;
}

export interface AssignmentReport extends AchievedMix {}

export interface QuestionReviewView {
  questions: QuestionView[];
  report: AssignmentReport | null;
}
