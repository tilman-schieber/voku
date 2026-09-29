import {
  DEFAULT_MCQ_OPTIONS,
  DEFAULT_MIX,
  DefinitionBatchSchema,
  ExtractionResultSchema,
  FillBlankBatchSchema,
  McqDistractorsBatchSchema,
  MixWeightsSchema,
  QuestionPayloadSchema,
  TranscriptionSchema,
  WordEnrichmentBatchSchema,
  type AchievedMix,
  type CefrLevel,
  type QuestionPayload,
  type QuestionType,
} from '@voku/shared';
import type { Db } from '../../db/index.js';
import { json } from '../../db/index.js';
import { conflict } from '../../http.js';
import { assignFormats } from '../assign.js';
import { buildOffline, resolveDirection, type BuildableWord } from '../build-questions.js';
import { makeRng, seedFrom, shuffle } from '../rng.js';
import {
  addWords,
  includedWords,
  replaceQuestions,
  toAssignable,
  toBuildable,
  type TestRow,
  type WordRow,
} from '../tests.js';
import type { JobReporter } from '../jobs.js';
import { chatJson, type LlmConfig } from './client.js';
import { plainText } from '../annotate.js';
import {
  DEFINITION_SYSTEM,
  DISTRACTOR_SYSTEM,
  ENRICH_SYSTEM,
  EXTRACT_SYSTEM,
  GAP_SYSTEM,
  TRANSCRIBE_SYSTEM,
  TRANSCRIBE_USER,
  definitionUser,
  distractorUser,
  enrichUser,
  extractUser,
  gapUser,
} from './prompts.js';

/** Small enough that one bad item does not spoil a whole test's worth of output. */
const BATCH_SIZE = 8;
/** Enough parallelism to be quick, few enough not to trip provider rate limits. */
const CONCURRENCY = 3;

function batch<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Pass 0 — read text off a photograph or a PDF page
// ---------------------------------------------------------------------------

export async function transcribeImages(config: LlmConfig, dataUris: string[]): Promise<string> {
  const result = await chatJson(config, {
    system: TRANSCRIBE_SYSTEM,
    user: TRANSCRIBE_USER,
    schema: TranscriptionSchema,
    images: dataUris.map((dataUri) => ({ dataUri })),
    // Falls back to the main model, which is usually multimodal anyway.
    model: config.visionModel ?? config.model,
    maxTokens: 6000,
    temperature: 0,
  });
  return result.text;
}

// ---------------------------------------------------------------------------
// Pass 1 — pull out the words worth training
// ---------------------------------------------------------------------------

export async function extractWords(
  db: Db,
  config: LlmConfig,
  test: TestRow,
  level: CefrLevel,
  maxWords: number,
): Promise<{ added: number }> {
  // Markers would only distract the model.
  const text = plainText(test.source_text).trim();
  if (!text) throw conflict('Add the text first.');

  const result = await chatJson(config, {
    system: EXTRACT_SYSTEM,
    user: extractUser(text, level, maxWords),
    schema: ExtractionResultSchema,
    maxTokens: 8000,
    temperature: 0.2,
  });

  const existing = new Set(
    db
      .all<{ headword_en: string }>('SELECT headword_en FROM test_words WHERE test_id = :t', {
        t: test.id,
      })
      .map((r) => r.headword_en.toLowerCase()),
  );

  const fresh = result.words.filter((word) => {
    const key = (word.lemma ?? word.headword).toLowerCase();
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  });

  const added = addWords(
    db,
    test.id,
    fresh.map((word) => ({
      headwordEn: word.lemma ?? word.headword,
      translationDe: word.translationDe,
      pos: word.pos ?? null,
      difficulty: word.difficulty,
      trickiness: word.trickiness,
      trickinessKind: word.trickinessKind,
      trickinessNote: word.trickinessNote ?? null,
      contextSentence: word.contextSentence ?? null,
      acceptedEn: word.alternativesEn,
      acceptedDe: word.alternativesDe,
      suitsFillBlank: word.suitsFillBlank,
      suitsDefinitionMcq: word.suitsDefinitionMcq,
      origin: 'ai',
    })),
  );

  return { added: added.length };
}

// ---------------------------------------------------------------------------
// Worksheet enrichment — fill the gaps in the printed sheet
// ---------------------------------------------------------------------------

/**
 * Writes a definition and an example sentence for every included word that is
 * missing one.
 *
 * Only the empty field is written. A context sentence lifted from the source
 * text is the teacher's own material and shows the word where the class met it,
 * so an invented sentence must never displace it. Re-running therefore costs
 * only the words that are still bare, and a definition the teacher has edited
 * survives.
 */
export async function enrichWords(
  db: Db,
  config: LlmConfig,
  test: TestRow,
  report: JobReporter,
): Promise<{ filled: number; skipped: number }> {
  const words = includedWords(db, test.id);
  const bare = words.filter((w) => !w.definition_en || !w.context_sentence);

  report.setTotal(batch(bare, BATCH_SIZE).length);
  if (bare.length === 0) return { filled: 0, skipped: words.length };

  let filled = 0;

  await mapWithLimit(batch(bare, BATCH_SIZE), CONCURRENCY, async (chunk) => {
    const result = await chatJson(config, {
      system: ENRICH_SYSTEM,
      user: enrichUser(
        chunk.map((w) => ({
          headword: w.headword_en,
          translationDe: w.translation_de,
          pos: w.pos,
          context: w.context_sentence,
        })),
      ),
      schema: WordEnrichmentBatchSchema,
    });
    const found = new Map(result.items.map((i) => [i.headword.toLowerCase(), i]));

    for (const word of chunk) {
      const item = found.get(word.headword_en.toLowerCase());
      if (!item) continue;

      const sets: string[] = [];
      const params: Record<string, unknown> = { id: word.id };

      // A definition that spells out the word answers its own question.
      if (!word.definition_en && !leaksHeadword(item.definition, word.headword_en)) {
        sets.push('definition_en = :definition');
        params.definition = item.definition;
      }
      // The mirror image: an example that never uses the word is not an example.
      if (!word.context_sentence && containsHeadword(item.example, word.headword_en)) {
        sets.push('context_sentence = :example');
        params.example = item.example;
      }

      if (sets.length > 0) {
        db.run(`UPDATE test_words SET ${sets.join(', ')} WHERE id = :id`, params);
        filled += 1;
      }
    }
    report.advance();
  });

  return { filled, skipped: words.length - bare.length };
}

/** Matches the word and its inflections, so "reluctantly" counts as leaking "reluctant". */
function headwordPattern(headword: string): RegExp {
  const escaped = headword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}`, 'i');
}

function leaksHeadword(definition: string, headword: string): boolean {
  return headwordPattern(headword).test(definition);
}

function containsHeadword(example: string, headword: string): boolean {
  return headwordPattern(headword).test(example);
}

// ---------------------------------------------------------------------------
// Pass 2 — write the questions
// ---------------------------------------------------------------------------

function acceptedFor(word: WordRow, direction: 'de_en' | 'en_de'): { prompt: string; answer: string } {
  return direction === 'de_en'
    ? { prompt: word.translation_de, answer: word.headword_en }
    : { prompt: word.headword_en, answer: word.translation_de };
}

interface Planned {
  word: WordRow;
  type: QuestionType;
  direction: 'de_en' | 'en_de';
}

/**
 * Generates every question for a test.
 *
 * Typed translations need no model at all, so they are built locally and cost
 * nothing. The other three formats are grouped BY FORMAT and sent in batches,
 * which means each request has one uniform output shape — far more reliable
 * than asking for a mixed bag and hoping the model keeps the shapes straight.
 */
export async function generateWithLlm(
  db: Db,
  config: LlmConfig,
  test: TestRow,
  report: JobReporter,
): Promise<AchievedMix> {
  const words = includedWords(db, test.id);
  if (words.length === 0) throw conflict('Add some words before generating questions.');

  const mix = MixWeightsSchema.safeParse(json<unknown>(test.mix_json, {}));
  const { assignments, report: assignment } = assignFormats(
    words.map(toAssignable),
    mix.success ? mix.data : DEFAULT_MIX,
    { anyWord: test.mcq_any_word === 1 },
  );

  const byWordId = new Map(words.map((w) => [w.id, w]));
  const typeOf = new Map(assignments.map((a) => [a.wordId, a.type]));
  const planned: Planned[] = words.map((word, index) => ({
    word,
    type: typeOf.get(word.id) ?? 'translate_input',
    direction: resolveDirection(test.direction, index),
  }));

  const rng = makeRng(seedFrom(test.id));
  const byId = new Map<string, QuestionPayload>();

  // Typed translations, built locally.
  const localTargets = planned.filter((p) => p.type === 'translate_input');
  for (const built of buildOffline(
    localTargets.map((p) => toBuildable(p.word)),
    localTargets.map((p) => ({ wordId: p.word.id, type: 'translate_input' as const })),
    { direction: test.direction, rng },
  )) {
    byId.set(built.wordId, built.payload);
  }

  const mcq = planned.filter((p) => p.type === 'mcq_translation');
  const definitions = planned.filter((p) => p.type === 'mcq_definition');
  const gaps = planned.filter((p) => p.type === 'fill_blank');

  report.setTotal(
    batch(mcq, BATCH_SIZE).length + batch(definitions, BATCH_SIZE).length + batch(gaps, BATCH_SIZE).length,
  );

  const failures: Planned[] = [];

  // --- multiple-choice translation ----------------------------------------
  // Grouped by direction so a batch asks for distractors in one language only.
  for (const direction of ['de_en', 'en_de'] as const) {
    const group = mcq.filter((p) => p.direction === direction);
    if (group.length === 0) continue;

    await mapWithLimit(batch(group, BATCH_SIZE), CONCURRENCY, async (chunk) => {
      const items = chunk.map((p) => ({
        headword: p.word.headword_en,
        answer: acceptedFor(p.word, direction).answer,
        note: p.word.trickiness_note,
      }));
      const result = await chatJson(config, {
        system: DISTRACTOR_SYSTEM,
        user: distractorUser(items, direction === 'de_en' ? 'English' : 'German', DEFAULT_MCQ_OPTIONS - 1),
        schema: McqDistractorsBatchSchema,
      });
      const found = new Map(result.items.map((i) => [i.headword.toLowerCase(), i.distractors]));

      for (const plan of chunk) {
        const { prompt, answer } = acceptedFor(plan.word, direction);
        const distractors = (found.get(plan.word.headword_en.toLowerCase()) ?? [])
          .map((d) => d.trim())
          .filter((d) => d && d.toLowerCase() !== answer.toLowerCase());
        const unique = [...new Map(distractors.map((d) => [d.toLowerCase(), d])).values()];

        if (unique.length < 2) {
          failures.push(plan);
          continue;
        }
        const options = shuffle([answer, ...unique.slice(0, DEFAULT_MCQ_OPTIONS - 1)], rng);
        byId.set(plan.word.id, {
          type: 'mcq_translation',
          direction,
          prompt,
          options,
          correctIndex: options.indexOf(answer),
        });
      }
      report.advance();
    });
  }

  // --- definition multiple choice -----------------------------------------
  await mapWithLimit(batch(definitions, BATCH_SIZE), CONCURRENCY, async (chunk) => {
    const result = await chatJson(config, {
      system: DEFINITION_SYSTEM,
      user: definitionUser(
        chunk.map((p) => ({ headword: p.word.headword_en, pos: p.word.pos })),
        DEFAULT_MCQ_OPTIONS - 1,
      ),
      schema: DefinitionBatchSchema,
    });
    const found = new Map(result.items.map((i) => [i.headword.toLowerCase(), i]));

    for (const plan of chunk) {
      const item = found.get(plan.word.headword_en.toLowerCase());
      const answer = plan.word.headword_en;
      const distractors = (item?.distractors ?? [])
        .map((d) => d.trim())
        .filter((d) => d && d.toLowerCase() !== answer.toLowerCase());
      const unique = [...new Map(distractors.map((d) => [d.toLowerCase(), d])).values()];

      // A definition containing the word is the answer written out — reject it.
      const leaks = item ? new RegExp(`\\b${answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(item.definition) : true;
      if (!item || leaks || unique.length < 2) {
        failures.push(plan);
        continue;
      }
      const options = shuffle([answer, ...unique.slice(0, DEFAULT_MCQ_OPTIONS - 1)], rng);
      byId.set(plan.word.id, {
        type: 'mcq_definition',
        definition: item.definition,
        options,
        correctIndex: options.indexOf(answer),
      });
    }
    report.advance();
  });

  // --- gap fill ------------------------------------------------------------
  await mapWithLimit(batch(gaps, BATCH_SIZE), CONCURRENCY, async (chunk) => {
    const result = await chatJson(config, {
      system: GAP_SYSTEM,
      user: gapUser(
        chunk.map((p) => ({
          headword: p.word.headword_en,
          translationDe: p.word.translation_de,
          context: p.word.context_sentence,
        })),
      ),
      schema: FillBlankBatchSchema,
    });
    const found = new Map(result.items.map((i) => [i.headword.toLowerCase(), i]));

    for (const plan of chunk) {
      const item = found.get(plan.word.headword_en.toLowerCase());
      if (!item) {
        failures.push(plan);
        continue;
      }
      const accepted = [
        ...new Map(
          [...item.accepted, plan.word.headword_en, ...json<string[]>(plan.word.accepted_en_json, [])]
            .map((a) => a.trim())
            .filter(Boolean)
            .map((a) => [a.toLowerCase(), a]),
        ).values(),
      ];
      const candidate = { type: 'fill_blank' as const, sentence: item.sentence, accepted, hint: plan.word.translation_de };
      // The schema enforces exactly one gap; a model that wrote two loses this one.
      if (!QuestionPayloadSchema.safeParse(candidate).success) {
        failures.push(plan);
        continue;
      }
      byId.set(plan.word.id, candidate);
    }
    report.advance();
  });

  // --- anything the model could not produce falls back to a typed question --
  if (failures.length > 0) {
    const fallbacks = buildOffline(
      failures.map((p) => toBuildable(p.word) satisfies BuildableWord),
      failures.map((p) => ({ wordId: p.word.id, type: 'translate_input' as const })),
      { direction: test.direction, rng },
    );
    for (const built of fallbacks) byId.set(built.wordId, built.payload);
  }

  replaceQuestions(
    db,
    test.id,
    words,
    [...byId].map(([wordId, payload]) => ({ wordId, type: payload.type, payload })),
  );

  const achieved = { ...assignment.achieved };
  const shortfalls = [...assignment.shortfalls];
  const failuresByType = new Map<QuestionType, number>();
  for (const plan of failures) {
    failuresByType.set(plan.type, (failuresByType.get(plan.type) ?? 0) + 1);
  }
  for (const [type, count] of failuresByType) {
    achieved[type] -= count;
    achieved.translate_input += count;
    shortfalls.push({
      type,
      wanted: assignment.achieved[type],
      got: assignment.achieved[type] - count,
      reason: 'the model could not write a usable question for these — they became typed translations',
    });
  }

  const finalReport: AchievedMix = { ...assignment, achieved, shortfalls };
  db.run('UPDATE tests SET report_json = :report WHERE id = :id', {
    report: JSON.stringify(finalReport),
    id: test.id,
  });
  // Guard against a word silently losing its question.
  if (byId.size !== words.length) {
    console.warn(`[voku] test ${test.id}: ${words.length - byId.size} words produced no question`);
  }
  return finalReport;
}

/** Rewrites a single question, optionally in a different format. */
export async function regenerateOne(
  db: Db,
  config: LlmConfig,
  test: TestRow,
  word: WordRow,
  type: QuestionType,
  index: number,
): Promise<QuestionPayload> {
  const direction = resolveDirection(test.direction, index);
  const rng = makeRng(seedFrom(`${word.id}:${Date.now()}`));

  if (type === 'translate_input') {
    const [built] = buildOffline([toBuildable(word)], [{ wordId: word.id, type }], {
      direction: test.direction,
      rng,
    });
    return built!.payload;
  }

  const fake: JobReporter = { setTotal: () => {}, advance: () => {} };
  void fake;

  if (type === 'mcq_translation') {
    const { prompt, answer } = acceptedFor(word, direction);
    const result = await chatJson(config, {
      system: DISTRACTOR_SYSTEM,
      user: distractorUser(
        [{ headword: word.headword_en, answer, note: word.trickiness_note }],
        direction === 'de_en' ? 'English' : 'German',
        DEFAULT_MCQ_OPTIONS - 1,
      ),
      schema: McqDistractorsBatchSchema,
      temperature: 0.7,
    });
    const distractors = (result.items[0]?.distractors ?? [])
      .map((d) => d.trim())
      .filter((d) => d && d.toLowerCase() !== answer.toLowerCase());
    if (distractors.length < 2) throw conflict('Could not write believable wrong answers for this word.');
    const options = shuffle([answer, ...distractors.slice(0, DEFAULT_MCQ_OPTIONS - 1)], rng);
    return { type, direction, prompt, options, correctIndex: options.indexOf(answer) };
  }

  if (type === 'mcq_definition') {
    const result = await chatJson(config, {
      system: DEFINITION_SYSTEM,
      user: definitionUser([{ headword: word.headword_en, pos: word.pos }], DEFAULT_MCQ_OPTIONS - 1),
      schema: DefinitionBatchSchema,
      temperature: 0.7,
    });
    const item = result.items[0];
    const distractors = (item?.distractors ?? []).map((d) => d.trim()).filter(Boolean);
    if (!item || distractors.length < 2) throw conflict('Could not write a definition for this word.');
    const options = shuffle([word.headword_en, ...distractors.slice(0, DEFAULT_MCQ_OPTIONS - 1)], rng);
    return {
      type,
      definition: item.definition,
      options,
      correctIndex: options.indexOf(word.headword_en),
    };
  }

  const result = await chatJson(config, {
    system: GAP_SYSTEM,
    user: gapUser([
      {
        headword: word.headword_en,
        translationDe: word.translation_de,
        context: word.context_sentence,
      },
    ]),
    schema: FillBlankBatchSchema,
    temperature: 0.7,
  });
  const item = result.items[0];
  if (!item) throw conflict('Could not write a gap sentence for this word.');
  return QuestionPayloadSchema.parse({
    type: 'fill_blank',
    sentence: item.sentence,
    accepted: [...new Set([...item.accepted, word.headword_en].map((a) => a.trim()).filter(Boolean))],
    hint: word.translation_de,
  });
}
