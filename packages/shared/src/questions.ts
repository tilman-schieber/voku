import { z } from 'zod';

/** Marker for the gap in a fill-in-the-blank sentence. */
export const BLANK = '___';

export const QUESTION_TYPES = [
  'translate_input',
  'mcq_translation',
  'mcq_definition',
  'fill_blank',
] as const;

export const QuestionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

/** Direction of a single question, once the test-level setting has been resolved. */
export const QuestionDirectionSchema = z.enum(['de_en', 'en_de']);
export type QuestionDirection = z.infer<typeof QuestionDirectionSchema>;

/** Test-level setting; `mixed` is resolved per question at generation time. */
export const TestDirectionSchema = z.enum(['de_en', 'en_de', 'mixed']);
export type TestDirection = z.infer<typeof TestDirectionSchema>;

const text = z.string().trim().min(1);

const TranslateInputObject = z.object({
  type: z.literal('translate_input'),
  direction: QuestionDirectionSchema,
  /** The word shown to the student, in the source language of `direction`. */
  prompt: text,
  /** All answers that count as correct. `accepted[0]` is the canonical one. */
  accepted: z.array(text).min(1),
  /**
   * The sentence the word was met in, shown under the prompt.
   *
   * A bare word has no sense attached to it: `address` is *ansprechen* or
   * *thematisieren* depending on the sentence, and a student who cannot see
   * which is being asked is guessing rather than recalling. Asking into
   * English the sentence is blanked, because it would otherwise contain the
   * answer; asking into German it stands as written.
   */
  context: text.optional(),
});

const McqTranslationObject = z.object({
  type: z.literal('mcq_translation'),
  direction: QuestionDirectionSchema,
  prompt: text,
  options: z.array(text).min(2).max(6),
  correctIndex: z.number().int().min(0),
});

const McqDefinitionObject = z.object({
  type: z.literal('mcq_definition'),
  /** English explanation of the word. No German involved in this format. */
  definition: text,
  /** English words, one of which the definition describes. */
  options: z.array(text).min(2).max(6),
  correctIndex: z.number().int().min(0),
});

const FillBlankObject = z.object({
  type: z.literal('fill_blank'),
  /** Must contain exactly one BLANK marker. */
  sentence: text,
  accepted: z.array(text).min(1),
  /** Optional nudge, e.g. the German translation. */
  hint: text.optional(),
});

/**
 * Cross-field rules live on the union rather than on each object, so the members
 * stay plain ZodObjects and `discriminatedUnion` keeps working across zod versions.
 */
export const QuestionPayloadSchema = z
  .discriminatedUnion('type', [
    TranslateInputObject,
    McqTranslationObject,
    McqDefinitionObject,
    FillBlankObject,
  ])
  .superRefine((p, ctx) => {
    if (p.type === 'mcq_translation' || p.type === 'mcq_definition') {
      if (p.correctIndex >= p.options.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['correctIndex'],
          message: `correctIndex ${p.correctIndex} is out of range for ${p.options.length} options`,
        });
      }
      const seen = new Set(p.options.map((o) => o.toLowerCase()));
      if (seen.size !== p.options.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: 'options must be distinct — a duplicated option makes the question unanswerable',
        });
      }
    }
    if (p.type === 'fill_blank') {
      const gaps = p.sentence.split(BLANK).length - 1;
      if (gaps !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['sentence'],
          message: `sentence must contain exactly one "${BLANK}" marker, found ${gaps}`,
        });
      }
    }
  });

export type TranslateInputPayload = z.infer<typeof TranslateInputObject>;
export type McqTranslationPayload = z.infer<typeof McqTranslationObject>;
export type McqDefinitionPayload = z.infer<typeof McqDefinitionObject>;
export type FillBlankPayload = z.infer<typeof FillBlankObject>;
export type QuestionPayload = z.infer<typeof QuestionPayloadSchema>;

/** What a student is allowed to see. Every answer-bearing field is gone. */
export type StudentQuestionPayload =
  | Omit<TranslateInputPayload, 'accepted'>
  | Omit<McqTranslationPayload, 'correctIndex'>
  | Omit<McqDefinitionPayload, 'correctIndex'>
  | Omit<FillBlankPayload, 'accepted'>;

/**
 * The single chokepoint between stored questions and student responses.
 * Every route that sends a question to a student goes through here, so an
 * answer cannot leak by someone hand-rolling a response object.
 */
export function stripAnswer(payload: QuestionPayload): StudentQuestionPayload {
  switch (payload.type) {
    case 'translate_input': {
      const { accepted, ...rest } = payload;
      void accepted;
      return rest;
    }
    case 'mcq_translation': {
      const { correctIndex, ...rest } = payload;
      void correctIndex;
      return rest;
    }
    case 'mcq_definition': {
      const { correctIndex, ...rest } = payload;
      void correctIndex;
      return rest;
    }
    case 'fill_blank': {
      const { accepted, ...rest } = payload;
      void accepted;
      return rest;
    }
  }
}

/** The answer to show after a wrong attempt, and the target for "almost" hints. */
export function correctAnswerText(payload: QuestionPayload): string {
  switch (payload.type) {
    case 'translate_input':
    case 'fill_blank':
      return payload.accepted[0]!;
    case 'mcq_translation':
    case 'mcq_definition':
      return payload.options[payload.correctIndex]!;
  }
}

/** Free-text formats return their accepted list; multiple-choice formats return null. */
export function acceptedAnswers(payload: QuestionPayload): string[] | null {
  switch (payload.type) {
    case 'translate_input':
    case 'fill_blank':
      return payload.accepted;
    case 'mcq_translation':
    case 'mcq_definition':
      return null;
  }
}

export function isMultipleChoice(
  payload: QuestionPayload,
): payload is McqTranslationPayload | McqDefinitionPayload {
  return payload.type === 'mcq_translation' || payload.type === 'mcq_definition';
}
