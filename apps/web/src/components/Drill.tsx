import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DrillChoice, DrillFeedback, DrillItem, DrillView } from '@voku/shared';
import { api } from '../lib/api.ts';
import {
  answer as record,
  current as currentCard,
  done,
  isOver,
  isReturn,
  neededAnotherGo,
  startRound,
  tally,
  type DrillMode,
  type Round,
} from '../lib/drill-round.ts';
import {
  EMPTY,
  clear as clearProgress,
  knownCount,
  load as loadProgress,
  nextStage,
  record as recordProgress,
  save as saveProgress,
  type Progress,
} from '../lib/practice-progress.ts';
import { Button, Empty, Spinner } from './ui.tsx';
import { FeedbackFlash, QuestionCard, holdUntilNext, useFlash } from './Sprint.tsx';

/**
 * Drilling the word pairs.
 *
 * One component for the class and for the teacher previewing them, so a preview
 * cannot quietly differ from the thing it is previewing — only the path differs.
 * The order of a round — when a missed word comes back, and whether as a choice
 * or typed — lives in `lib/drill-round.ts`, where it can be read on its own.
 *
 * Nothing is stored anywhere: the run lives here and dies with the tab, which is
 * the honest shape for something the server deliberately does not remember.
 */
export function Drill({
  path,
  queryKey,
  heading,
  action,
  progressKey,
}: {
  /** API path serving the drill; answers are POSTed to the same one. */
  path: string;
  queryKey: unknown[];
  heading: ReactNode;
  /** Sits at the right of the header — "Close" for a student, "Done" for a preview. */
  action: ReactNode;
  /**
   * Which list this is, for the device's memory of it. Paired with the student
   * signed in here — school iPads are shared, and one child's stage must not
   * become the next child's. Left out by the teacher's preview, which is a look
   * at the drill, not a go at the list.
   */
  progressKey?: { studentId: string; list: string };
}) {
  const [round, setRound] = useState<Round | null>(null);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState(false);
  // A round of words that already went wrong cannot make any of them "known":
  // right first time there means first time among the ones just missed.
  const [promotes, setPromotes] = useState(true);
  const [progress, setProgress] = useState<Progress>(() =>
    progressKey ? loadProgress(progressKey.studentId, progressKey.list) : EMPTY,
  );
  // No clock here, so the answer waits for the student rather than the other
  // way round — the timed flash was the first thing the class complained about.
  const { feedback, show, next } = useFlash<DrillFeedback>(holdUntilNext);

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => api.get<DrillView>(path),
  });

  const items = useMemo(
    () => new Map((data?.items ?? []).map((item) => [item.wordId, item])),
    [data],
  );

  const begin = useCallback((wordIds: string[], { promote = true } = {}) => {
    setPromotes(promote);
    setRound(startRound(shuffled(wordIds)));
  }, []);

  const allIds = useMemo(() => (data?.items ?? []).map((item) => item.wordId), [data]);

  // A stage rather than the whole list, picking up where this device left off.
  // Everything known already means the stage is empty, and then the round is
  // the whole list again — finished should mean "go again", not a wall.
  useEffect(() => {
    if (!data || round !== null) return;
    const stage = progressKey ? nextStage(allIds, progress) : [];
    begin(stage.length > 0 ? stage : allIds);
  }, [data, round, begin, allIds, progress, progressKey]);

  // Recorded once, when the round ends: what the student got right first time.
  const recorded = useRef<Round | null>(null);
  useEffect(() => {
    if (!round || !progressKey || !isOver(round) || recorded.current === round) return;
    recorded.current = round;
    const updated = recordProgress(progress, round.outcome, { promote: promotes });
    saveProgress(progressKey.studentId, progressKey.list, updated);
    setProgress(updated);
  }, [round, progress, progressKey, promotes]);

  const card = round ? currentCard(round) : undefined;
  const item = card ? items.get(card.wordId) : undefined;

  // Only fetched when a missed word comes back; the first outing is always typed.
  const choice = useQuery({
    queryKey: [...queryKey, 'choice', card?.wordId],
    queryFn: () => api.get<DrillChoice>(`${path}/${card!.wordId}/choice`),
    enabled: card?.mode === 'choice',
    staleTime: Infinity,
  });

  if (isLoading) return <Spinner />;
  if (error || !data) {
    return (
      <Empty title="Not ready yet">
        These words are not open for practice right now.
      </Empty>
    );
  }
  if (data.items.length === 0) {
    return <Empty title="No words yet">Add some words and they will appear here to practise.</Empty>;
  }
  if (!round) return <Spinner />;

  // A choice card with no fair choice to offer is simply asked as typing again.
  const askedAs: DrillMode =
    card?.mode === 'choice' && (choice.data?.options.length ?? 0) > 0 ? 'choice' : 'typed';
  const waitingForChoice = card?.mode === 'choice' && choice.isLoading;

  const submit = async (given: string) => {
    if (!card || busy) return;
    setBusy(true);
    setSkipped(given === '');
    try {
      const result = await api.post<DrillFeedback>(path, { wordId: card.wordId, given });
      show(result, () => {
        setRound((r) => (r ? record(r, result.correct, askedAs) : r));
        setBusy(false);
        setSkipped(false);
      });
    } catch {
      setBusy(false);
      setSkipped(false);
    }
  };

  const over = isOver(round);
  const counts = tally(round);
  const again = neededAnotherGo(round);
  // What a next stage would hold — empty once this device has the whole list.
  const ahead = progressKey ? nextStage(allIds, progress) : [];

  // Said quietly above the question: where the word is from, and why it is back.
  const note = card
    ? [
        item?.repeatedFrom ? `from ${item.repeatedFrom}` : null,
        isReturn(round, card)
          ? askedAs === 'choice'
            ? 'another go — pick the right one'
            : 'now type it yourself'
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div className="flex flex-1 flex-col">
      <header className="rule-b flex flex-wrap items-baseline justify-between gap-4 pb-5">
        {heading}
        <div className="flex items-center gap-6">
          {progressKey && allIds.length > 0 ? (
            // This iPad's memory, said plainly so nobody expects it elsewhere.
            <span className="label text-ink-40">
              {knownCount(allIds, progress)}/{allIds.length} learned here
            </span>
          ) : null}
          {!over ? (
            // Words, not cards: a missed word coming back must not make the
            // total jump, or the round looks like it is getting longer.
            <span className="tabular text-sm text-ink-40">
              {done(round)}/{round.total}
            </span>
          ) : null}
          {action}
        </div>
      </header>

      {/* No progress line: its tick marks the sprint's target, and practice has
          no target to reach. The count in the header is the whole story. */}
      <div className="flex flex-1 flex-col justify-center py-10">
        {over ? (
          <div className="flex flex-col items-center gap-6 text-center">
            <span className="label">Right first time</span>
            <p className="text-display font-semibold tracking-tight">
              {counts.first}
              <span className="text-ink-40">/{round.total}</span>
            </p>
            <p className="max-w-md text-lg text-ink-40">
              {again.length === 0
                ? 'All of them. Nothing left to practise here.'
                : [
                    counts.recovered > 0 ? `${counts.recovered} got there on another go` : null,
                    counts.missed > 0 ? `${counts.missed} still to learn` : null,
                  ]
                    .filter(Boolean)
                    .join(', ') + '. Practising costs nothing — go again.'}
            </p>
            {progressKey ? (
              <p className="max-w-md text-sm text-ink-40">
                {ahead.length > 0
                  ? `${knownCount(allIds, progress)} of ${allIds.length} words are behind you on this iPad. The next stage carries on from there.`
                  : `That is the whole list on this iPad — ${allIds.length} words. Going again starts from the beginning.`}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-4">
              {again.length > 0 ? (
                // Nothing here can become "known": these are the words that
                // just went wrong, and getting one right among them is not the
                // same as getting it right in the stage.
                <Button variant="primary" size="lg" onClick={() => begin(again, { promote: false })}>
                  The ones that needed another go
                </Button>
              ) : null}
              {ahead.length > 0 ? (
                <Button
                  variant={again.length > 0 ? 'secondary' : 'primary'}
                  size="lg"
                  onClick={() => begin(ahead)}
                >
                  {`Next ${ahead.length} words`}
                </Button>
              ) : null}
              <Button
                variant={again.length > 0 || ahead.length > 0 ? 'secondary' : 'primary'}
                size="lg"
                onClick={() => begin(allIds)}
              >
                All of them again
              </Button>
              {progressKey && knownCount(allIds, progress) > 0 ? (
                <button
                  type="button"
                  className="label text-ink-40 transition-colors hover:text-ink"
                  onClick={() => {
                    clearProgress(progressKey.studentId, progressKey.list);
                    setProgress(EMPTY);
                  }}
                >
                  Start this list again
                </button>
              ) : null}
            </div>
          </div>
        ) : feedback ? (
          <FeedbackFlash feedback={feedback} skipped={skipped} onNext={next} />
        ) : waitingForChoice || !card || !item ? (
          <Spinner />
        ) : (
          <div className="flex flex-col gap-6">
            {note ? <p className="label text-center">{note}</p> : null}
            <QuestionCard
              question={{
                // Per card, not per word: the same word comes back, and its input
                // must start empty and take focus again when it does.
                id: `${card.wordId}:${round.at}`,
                index: round.at,
                total: round.cards.length,
                payload:
                  askedAs === 'choice'
                    ? {
                        type: 'mcq_translation',
                        direction: item.direction,
                        prompt: item.prompt,
                        options: choice.data!.options,
                      }
                    : {
                        type: 'translate_input',
                        direction: item.direction,
                        prompt: item.prompt,
                        ...(item.context ? { context: item.context } : {}),
                      },
              }}
              disabled={busy}
              chosen={null}
              correctAnswer={null}
              onAnswer={(given) =>
                // A choice answers with the option's position; the grader wants its text.
                void submit(askedAs === 'choice' ? choice.data!.options[Number(given)]! : given)
              }
              // Practice has nothing to protect: not knowing is a legitimate
              // answer, and the word comes straight back later in the round.
              onSkip={() => void submit('')}
              skipLabel="I don’t know this one"
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Fisher–Yates. Practice order is shuffled; only the real sprint is fixed. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
