import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnswerFeedback, StudentQuestionView } from '@voku/shared';
import { AnswerInput, Button, cx } from './ui.tsx';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * The progress line. A hairline track with a terracotta fill and a tick at the
 * target.
 *
 * The score is uncapped, and under a single-accent palette the overshoot cannot
 * be a second colour. So the fill simply continues past the tick — the fact that
 * it is *beyond the mark* carries the meaning, and the number does the rest.
 */
export function ProgressLine({
  correct,
  target,
  className,
}: {
  correct: number;
  target: number;
  className?: string;
}) {
  const percent = target > 0 ? (correct / target) * 100 : 0;
  // Track spans 0–175% of target, so the tick sits at 4/7 with room above it.
  const SCALE = 175;
  const width = Math.min(percent / SCALE, 1) * 100;

  return (
    <div className={cx('relative h-px w-full bg-hairline', className)}>
      <div
        className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-500 ease-out"
        style={{ width: `${width}%` }}
      />
      <div className="absolute -top-1 bottom-[-0.25rem] left-[57.14%] w-px bg-hairline-strong" />
    </div>
  );
}

export function Countdown({ deadlineAt, onExpire }: { deadlineAt: string; onExpire: () => void }) {
  const [left, setLeft] = useState(() =>
    Math.max(0, Math.round((new Date(deadlineAt).getTime() - Date.now()) / 1000)),
  );
  const fired = useRef(false);

  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const seconds = Math.max(0, Math.round((new Date(deadlineAt).getTime() - Date.now()) / 1000));
      setLeft(seconds);
      if (seconds === 0 && !fired.current) {
        fired.current = true;
        onExpire();
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadlineAt, onExpire]);

  const minutes = Math.floor(left / 60);
  const seconds = left % 60;

  return (
    <span
      className={cx('tabular text-sm font-semibold tracking-[0.08em]', left <= 30 ? 'text-accent' : 'text-ink-40')}
      aria-label={`${minutes} minutes ${seconds} seconds left`}
    >
      {minutes}:{String(seconds).padStart(2, '0')}
    </span>
  );
}

export interface QuestionProps {
  question: StudentQuestionView;
  disabled: boolean;
  /** Set once answered, so the chosen row can show its state before advancing. */
  chosen: string | null;
  correctAnswer: string | null;
  onAnswer: (given: string) => void;
  /**
   * Hands the question in unanswered. Present in the sprint, where a word you
   * do not know otherwise eats the clock while you type something to escape it;
   * wrong answers cost nothing, so this only makes that honest.
   */
  onSkip?: () => void;
  /** "Skip this word" in the sprint; practice says what it really is. */
  skipLabel?: string;
}

/** One question, one focal element, centred on a flat plane. */
export function QuestionCard({
  question,
  disabled,
  chosen,
  correctAnswer,
  onAnswer,
  onSkip,
  skipLabel = 'Skip this word',
}: QuestionProps) {
  const payload = question.payload;
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText('');
    inputRef.current?.focus();
  }, [question.id]);

  if (payload.type === 'mcq_translation' || payload.type === 'mcq_definition') {
    const prompt = payload.type === 'mcq_translation' ? payload.prompt : payload.definition;
    return (
      <div className="flex flex-col gap-16">
        <Prompt
          label={payload.type === 'mcq_translation' ? 'Choose the translation' : 'Which word is this'}
          word={prompt}
          quiet={payload.type === 'mcq_definition'}
        />
        <ul className="rule-t mx-auto w-full max-w-2xl">
          {payload.options.map((option, index) => {
            const isChosen = chosen === String(index);
            const isCorrect = correctAnswer !== null && option === correctAnswer;
            return (
              <li key={`${question.id}-${index}`} className="rule-b">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onAnswer(String(index))}
                  className={cx(
                    'flex w-full items-center justify-between gap-6 px-1 py-5 text-left text-2xl',
                    'transition-colors disabled:cursor-default',
                    // Selected/correct state is a heavier accent underline, never a fill.
                    (isChosen || isCorrect) && 'border-b-2 border-accent text-accent',
                    !isChosen && !isCorrect && !disabled && 'hover:text-accent',
                    disabled && !isChosen && !isCorrect && 'text-ink-40',
                  )}
                >
                  <span>{option}</span>
                  <span className="label shrink-0">{LETTERS[index]}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <SkipLink onSkip={onSkip} label={skipLabel} disabled={disabled} />
      </div>
    );
  }

  const submit = () => {
    if (!text.trim() || disabled) return;
    onAnswer(text);
  };

  if (payload.type === 'fill_blank') {
    const [before, after] = payload.sentence.split('___');
    return (
      <div className="flex flex-col gap-16">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center">
          <span className="label">Fill the gap</span>
          <p className="text-4xl leading-snug tracking-tight">
            {before}
            <span className="text-ink-25">_______</span>
            {after}
          </p>
          {payload.hint ? <p className="text-lg text-ink-40">{payload.hint}</p> : null}
        </div>
        <TypedAnswer
          inputRef={inputRef}
          value={text}
          onChange={setText}
          onSubmit={submit}
          disabled={disabled}
          onSkip={onSkip}
          skipLabel={skipLabel}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-16">
      <Prompt
        label={payload.direction === 'de_en' ? 'Translate to English' : 'Übersetze ins Deutsche'}
        word={payload.prompt}
        context={payload.context}
      />
      <TypedAnswer
        inputRef={inputRef}
        value={text}
        onChange={setText}
        onSubmit={submit}
        disabled={disabled}
        onSkip={onSkip}
        skipLabel={skipLabel}
      />
    </div>
  );
}

function Prompt({
  label,
  word,
  quiet = false,
  context,
}: {
  label: string;
  word: string;
  quiet?: boolean;
  /** The sentence the word was met in — which sense is being asked for. */
  context?: string;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center">
      <span className="label">{label}</span>
      <p
        className={cx(
          'font-semibold tracking-tight',
          quiet ? 'text-4xl leading-snug' : 'text-display',
        )}
      >
        {quiet ? `“${word}”` : word}
      </p>
      {context ? <p className="max-w-xl text-lg leading-snug text-ink-40">{context}</p> : null}
    </div>
  );
}

/** Quiet by design: an escape hatch, not an invitation. */
function SkipLink({
  onSkip,
  label,
  disabled,
}: {
  onSkip?: () => void;
  label: string;
  disabled: boolean;
}) {
  if (!onSkip) return null;
  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={onSkip}
        disabled={disabled}
        className="label text-ink-40 transition-colors hover:text-ink disabled:opacity-40"
      >
        {label}
      </button>
    </div>
  );
}

function TypedAnswer({
  inputRef,
  value,
  onChange,
  onSubmit,
  disabled,
  onSkip,
  skipLabel,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  onSkip?: () => void;
  skipLabel: string;
}) {
  return (
    <form
      className="mx-auto flex w-full max-w-lg flex-col items-center gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <AnswerInput
        ref={inputRef}
        value={value}
        disabled={disabled}
        placeholder="…"
        onChange={(event) => onChange(event.target.value)}
        enterKeyHint="go"
      />
      <Button type="submit" variant="primary" size="lg" disabled={disabled || !value.trim()}>
        Answer
      </Button>
      <SkipLink onSkip={onSkip} label={skipLabel} disabled={disabled} />
    </form>
  );
}

/**
 * Feedback between questions. Terracotta is reserved for the correct answer, so
 * a wrong answer is stated in plain near-black rather than a warning colour —
 * calm, not punitive, which is the tone the brief asks for.
 */
export function FeedbackFlash({
  feedback,
  skipped = false,
  onNext,
}: {
  // Only the three fields it actually shows, so practice — which keeps no score
  // — can use it without inventing a percentage to satisfy the type.
  feedback: Pick<AnswerFeedback, 'correct' | 'almost' | 'correctAnswer'>;
  /** The question was handed in unanswered, so "Not quite" would be a lie. */
  skipped?: boolean;
  /** Moves on now. Students asked for this: reading the answer takes as long as it takes. */
  onNext?: () => void;
}) {
  // Enter and space are where a hand already is after typing an answer.
  useEffect(() => {
    if (!onNext) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNext]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center" role="status" aria-live="assertive">
      <span className="label">
        {feedback.correct ? 'Correct' : skipped ? 'Skipped' : feedback.almost ? 'Almost' : 'Not quite'}
      </span>
      <p
        className={cx(
          'font-semibold tracking-tight',
          feedback.correct ? 'text-display text-accent' : 'text-hero',
        )}
      >
        {feedback.correctAnswer}
      </p>
      {!feedback.correct && feedback.almost ? (
        <p className="text-lg text-ink-40">One letter out.</p>
      ) : null}
      {onNext ? (
        <Button onClick={onNext} size="lg">
          Next
        </Button>
      ) : null}
    </div>
  );
}

/** How long the answer stays on screen when nobody presses Next. */
export const FLASH_CORRECT_MS = 900;
/** Longer when it was wrong: that is the one the student is there to read. */
export const FLASH_WRONG_MS = 2600;

export type FlashHold<T> = (feedback: T) => number | null;

/** Waits for the student instead of the clock — for untimed practice. */
export const holdUntilNext = () => null;

/**
 * Generic over the feedback shape, so practice — which keeps no score — fits.
 *
 * `hold` says how long the answer stays up. Returning `null` keeps it there
 * until Next is pressed, which is right where no clock is running; the sprint
 * keeps a timeout so a distracted student is not left on one word, but a right
 * answer goes by quickly and a wrong one waits long enough to be read.
 */
export function useFlash<T extends Pick<AnswerFeedback, 'correct' | 'almost' | 'correctAnswer'>>(
  hold: FlashHold<T> = (feedback) => (feedback.correct ? FLASH_CORRECT_MS : FLASH_WRONG_MS),
) {
  const [feedback, setFeedback] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<(() => void) | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  // Stable, so the key handler in the flash is not rebound on every render.
  const next = useCallback(() => {
    const then = pending.current;
    pending.current = null;
    clear();
    setFeedback(null);
    then?.();
  }, []);

  // Held in a ref so an inline `hold` does not give `show` a new identity.
  const holdRef = useRef(hold);
  holdRef.current = hold;

  const show = useCallback(
    (shown: T, then: () => void) => {
      setFeedback(shown);
      pending.current = then;
      clear();
      const ms = holdRef.current(shown);
      if (ms !== null) timer.current = setTimeout(next, ms);
    },
    [next],
  );

  useEffect(() => () => clear(), []);
  return { feedback, show, next };
}
