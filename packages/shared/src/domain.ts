import { z } from 'zod';
import { QUESTION_TYPES, QuestionTypeSchema, TestDirectionSchema } from './questions.js';

export const TestStatusSchema = z.enum(['draft', 'published', 'open', 'closed']);
export type TestStatus = z.infer<typeof TestStatusSchema>;

export const AttemptModeSchema = z.enum(['graded', 'practice']);
export type AttemptMode = z.infer<typeof AttemptModeSchema>;

export const WordOriginSchema = z.enum(['ai', 'manual', 'repeat']);
export type WordOrigin = z.infer<typeof WordOriginSchema>;

export const CefrLevelSchema = z.enum(['A1', 'A2', 'B1', 'B2', 'C1']);
export type CefrLevel = z.infer<typeof CefrLevelSchema>;

/**
 * Why a word is a trap. Drives which distractors the generator is asked for —
 * for a false friend, one distractor is what the German cognate actually means.
 */
export const TrickinessKindSchema = z.enum([
  'none',
  'false_friend',
  'confusable_pair',
  'misleading_compound',
]);
export type TrickinessKind = z.infer<typeof TrickinessKindSchema>;

export const DEFAULT_DURATION_SECONDS = 300;
/** Target defaults to this share of the question pool, leaving runway above 100%. */
export const DEFAULT_TARGET_RATIO = 0.6;
export const DEFAULT_MCQ_OPTIONS = 4;

/**
 * Relative weights, not quotas. Hard constraints (trickiness, format suitability)
 * are satisfied first; whatever words remain are distributed by these.
 */
export const MixWeightsSchema = z.object({
  translate_input: z.number().min(0).max(100),
  mcq_translation: z.number().min(0).max(100),
  mcq_definition: z.number().min(0).max(100),
  fill_blank: z.number().min(0).max(100),
});
export type MixWeights = z.infer<typeof MixWeightsSchema>;

export const DEFAULT_MIX: MixWeights = {
  translate_input: 45,
  mcq_translation: 15,
  mcq_definition: 15,
  fill_blank: 25,
};

/** Reported back after assignment so the teacher sees what the text actually supported. */
export interface AchievedMix {
  requested: MixWeights;
  achieved: Record<(typeof QUESTION_TYPES)[number], number>;
  total: number;
  /** Populated when a weighted format could not be filled, e.g. too few tricky words. */
  shortfalls: Array<{ type: (typeof QUESTION_TYPES)[number]; wanted: number; got: number; reason: string }>;
}

export const TestSettingsSchema = z.object({
  direction: TestDirectionSchema,
  durationSeconds: z.number().int().min(30).max(3600),
  targetCount: z.number().int().min(1),
  mix: MixWeightsSchema,
  /**
   * Lets multiple choice go to any word, not only traps and the harder ones.
   *
   * Off by default, because four options on an easy word are a free 25% and a
   * wrong answer costs nothing. On, because a text with few traps otherwise
   * yields a test that is nothing but typing, which is hardest on exactly the
   * students who need the choice most. The teacher decides which cost to pay,
   * per test, and sees the result in the numbers.
   */
  mcqAnyWord: z.boolean().default(false),
});
export type TestSettings = z.infer<typeof TestSettingsSchema>;

// ---------------------------------------------------------------------------
// LLM settings
// ---------------------------------------------------------------------------

export const LlmSettingsSchema = z.object({
  baseUrl: z.string().url(),
  /** Write-only from the client; responses report `hasApiKey` instead. */
  apiKey: z.string().optional(),
  model: z.string().min(1),
  /** Falls back to `model` when the main model can't read images. */
  visionModel: z.string().optional(),
});
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;

export interface LlmSettingsPublic {
  baseUrl: string;
  model: string;
  visionModel: string | null;
  hasApiKey: boolean;
}

// ---------------------------------------------------------------------------
// LLM pass 1 — word extraction
// ---------------------------------------------------------------------------

/**
 * One candidate word. `difficulty` orders the sprint and drives the top-N cutoff;
 * `trickiness` is independent of it and decides which words become multiple choice.
 * "become" is easy and very tricky; "nevertheless" is hard and not tricky at all.
 */
export const ExtractedWordSchema = z.object({
  headword: z.string().trim().min(1),
  lemma: z.string().trim().min(1).optional(),
  pos: z.string().trim().min(1).optional(),
  translationDe: z.string().trim().min(1),
  alternativesDe: z.array(z.string().trim().min(1)).default([]),
  alternativesEn: z.array(z.string().trim().min(1)).default([]),
  difficulty: z.number().int().min(1).max(10),
  trickiness: z.number().int().min(0).max(3),
  trickinessKind: TrickinessKindSchema.default('none'),
  /** Free text, e.g. "German 'Gift' means poison". Injected into the distractor prompt. */
  trickinessNote: z.string().trim().optional(),
  contextSentence: z.string().trim().optional(),
  suitsFillBlank: z.boolean(),
  suitsDefinitionMcq: z.boolean(),
});
export type ExtractedWord = z.infer<typeof ExtractedWordSchema>;

export const ExtractionResultSchema = z.object({
  words: z.array(ExtractedWordSchema),
});

// ---------------------------------------------------------------------------
// LLM pass 2 — question generation
//
// The model writes only the creative parts. The server assembles the final
// payload and randomises which slot the correct option lands in, so a model
// that always answers "A" cannot create a pattern.
// ---------------------------------------------------------------------------

export const McqDistractorsGenSchema = z.object({
  headword: z.string().trim().min(1),
  distractors: z.array(z.string().trim().min(1)).min(2).max(5),
});
export const McqDistractorsBatchSchema = z.object({
  items: z.array(McqDistractorsGenSchema),
});

export const DefinitionGenSchema = z.object({
  headword: z.string().trim().min(1),
  definition: z.string().trim().min(1),
  distractors: z.array(z.string().trim().min(1)).min(2).max(5),
});
export const DefinitionBatchSchema = z.object({
  items: z.array(DefinitionGenSchema),
});

export const FillBlankGenSchema = z.object({
  headword: z.string().trim().min(1),
  /** Must contain the BLANK marker; validated again when the payload is built. */
  sentence: z.string().trim().min(1),
  accepted: z.array(z.string().trim().min(1)).default([]),
});
export const FillBlankBatchSchema = z.object({
  items: z.array(FillBlankGenSchema),
});

export const TranscriptionSchema = z.object({
  text: z.string(),
});

// ---------------------------------------------------------------------------
// Worksheet enrichment — a definition and a worked example for every word
//
// Separate from the question passes above, because it runs over the whole list
// rather than the subset that drew a given format, and because it also has to
// serve words that were pasted rather than extracted from a text.
// ---------------------------------------------------------------------------

export const WordEnrichmentSchema = z.object({
  headword: z.string().trim().min(1),
  definition: z.string().trim().min(1),
  /** Contains the word, unlike a gap sentence — the sheet shows it in use. */
  example: z.string().trim().min(1),
});
export const WordEnrichmentBatchSchema = z.object({
  items: z.array(WordEnrichmentSchema),
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const JobKindSchema = z.enum(['transcribe', 'extract', 'generate', 'enrich']);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum(['queued', 'running', 'done', 'error']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export interface JobView {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  total: number;
  error: string | null;
  result: unknown;
}

export { QuestionTypeSchema, QUESTION_TYPES };
