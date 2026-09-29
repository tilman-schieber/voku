import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnswerFeedback,
  AttemptView,
  MyWordsView,
  QuestionPayload,
  StudentHomeView,
  StudentQuestionView,
} from '@voku/shared';
import { ApiError, api, student } from '../lib/api.ts';
import { forgetOthers } from '../lib/practice-progress.ts';
import { Button, Empty, Rows, Row, Spinner, Status, Wordmark, cx } from '../components/ui.tsx';
import { StudyText, type Block } from './StudyText.tsx';
import { Drill } from '../components/Drill.tsx';
import {
  Countdown,
  FeedbackFlash,
  ProgressLine,
  QuestionCard,
  useFlash,
} from '../components/Sprint.tsx';

interface AttemptState {
  attempt: AttemptView;
  question: StudentQuestionView | null;
}

/** Centred single-plane frame, sized for a tablet in landscape. */
function Screen({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx('mx-auto flex min-h-dvh w-full max-w-4xl flex-col px-8 py-8', className)}>
      {children}
    </div>
  );
}

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <Screen>
      <div className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
        {children}
      </div>
    </Screen>
  );
}

/**
 * Every dead end a student can reach — signed out, a dud code, a test that
 * ended. They all carry the wordmark, because these are the screens most likely
 * to be seen by someone who does not yet know what this app is, and a bare line
 * of grey text tells them nothing.
 */
function Message({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Centred>
      <Wordmark size="lg" />
      <div className="flex flex-col gap-3">
        <span className="label">{eyebrow}</span>
        <h1 className="text-hero">{title}</h1>
      </div>
      {children ? <div className="max-w-sm text-lg text-ink-60">{children}</div> : null}
      {action}
    </Centred>
  );
}

/** `/s/<token>` — swaps the token for a cookie so it leaves the address bar. */
/**
 * Who is signed in on this device, for anything kept per student rather than
 * per device. Undefined while it is still being fetched, so a caller waits
 * rather than guessing.
 */
function useMe(): string | undefined {
  const { data } = useQuery({
    queryKey: ['student', 'me'],
    queryFn: () => api.get<StudentHomeView>(student('/me')),
  });
  return data?.student.id;
}

function TokenLogin() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .post<{ id: string }>(student('/session'), { token })
      .then((me) => {
        if (cancelled) return;
        // A shared iPad: whoever had it before does not stay on it.
        forgetOthers(me.id);
        navigate('/s', { replace: true });
      })
      .catch((err: ApiError) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [token, navigate]);

  if (error) {
    return (
      <Message eyebrow="Sign in" title="That code did not work">
        {error} Ask your teacher for a new one — codes can be reprinted in a moment.
      </Message>
    );
  }
  return (
    <Centred>
      <Wordmark size="lg" />
      <Spinner label="Signing you in…" />
    </Centred>
  );
}

function Home() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['student', 'me'],
    queryFn: () => api.get<StudentHomeView>(student('/me')),
    // A test can open at any moment during the lesson.
    refetchInterval: 5000,
  });

  // Not polled like the rest of home: it only changes when a test closes. Held
  // back while one runs, so that the moment it closes — which is exactly when
  // new misses arrive — becoming enabled fetches the list afresh.
  const myWords = useQuery({
    queryKey: ['student', 'my-words'],
    queryFn: () => api.get<MyWordsView>(student('/my-words')),
    enabled: data ? !data.revisionPaused : false,
  });

  if (isLoading) return <Centred><Spinner /></Centred>;
  if (error) {
    return (
      <Message eyebrow="Vocabulary sprints" title="Scan your code to start">
        Point your camera at the code your teacher gave you. It signs you in and keeps you signed
        in — there is no password to remember.
      </Message>
    );
  }
  if (!data) return null;

  // One accent button on the page, for whatever matters most right now. The
  // accent is rationed; three of them in a column stop meaning "this one".
  const testRunning = data.openTests.length > 0;
  const hasOwnWords = (myWords.data?.words.length ?? 0) > 0;

  return (
    <Screen>
      <header className="rule-b flex items-baseline justify-between pb-5">
        <Wordmark size="sm" />
        <span className="label">
          {data.student.name} · {data.className}
        </span>
      </header>

      <div className="flex flex-col gap-14 py-12">
        <section className="flex flex-col gap-6">
          <span className="label">Ready</span>
          {data.openTests.length === 0 ? (
            <Empty title="Nothing to do right now">
              A quiz appears here the moment your teacher opens it.
            </Empty>
          ) : (
            <Rows>
              {data.openTests.map((test) => (
                <Row key={test.id}>
                  <div className="flex-1">
                    <p className="text-2xl font-semibold tracking-tight">{test.title}</p>
                    <p className="text-sm text-ink-40">
                      {Math.round(test.durationSeconds / 60)} minutes
                    </p>
                  </div>
                  {test.submitted ? (
                    <Status tone="quiet">Handed in</Status>
                  ) : (
                    <Button variant="primary" onClick={() => navigate(`/s/tests/${test.id}/sprint`)}>
                      {test.attemptId ? 'Carry on' : 'Start'}
                    </Button>
                  )}
                </Row>
              ))}
            </Rows>
          )}
        </section>

        {/* While any test in the class runs, home is the test and nothing else.
            A word brought back from an earlier unit is also a question now, so
            an earlier list would be the answers on screen — the server refuses
            them too; this only saves a student tapping into a closed door. */}
        {data.revisionPaused ? (
          <p className="max-w-prose text-ink-60">
            Word lists and practice are paused while a test is running. They come back as soon as
            it closes.
          </p>
        ) : null}

        {!data.revisionPaused && data.studyLists.length > 0 ? (
          <section className="flex flex-col gap-6">
            <span className="label">Words to learn</span>
            <Rows>
              {data.studyLists.map((list) => (
                <Row key={list.id} onClick={() => navigate(`/s/tests/${list.id}/words`)}>
                  <span className="flex-1 text-xl">{list.title}</span>
                  <span className="text-sm text-ink-40">{list.wordCount} words</span>
                  {/* One tap from the front door, but never the accent: there can
                      be several lists, and none of them is more urgent than the
                      others. */}
                  <Button
                    onClick={(event) => {
                      event.stopPropagation();
                      navigate(`/s/tests/${list.id}/drill`);
                    }}
                  >
                    Practise
                  </Button>
                </Row>
              ))}
            </Rows>
          </section>
        ) : null}

        {!data.revisionPaused && myWords.data ? (
          <MyWordsSection data={myWords.data} primary={!testRunning && hasOwnWords} />
        ) : null}

        {!data.revisionPaused && data.pastAttempts.length > 0 ? (
          <section className="flex flex-col gap-6">
            <span className="label">Finished</span>
            <Rows>
              {data.pastAttempts.map((attempt) => (
                <Row
                  key={attempt.attemptId}
                  onClick={() => navigate(`/s/attempts/${attempt.attemptId}/review`)}
                >
                  <span className="flex-1 text-xl">{attempt.testTitle}</span>
                  <span className="tabular text-2xl font-semibold tracking-tight">
                    {attempt.correctCount}
                    <span className="text-ink-40">/{attempt.targetCount}</span>
                  </span>
                </Row>
              ))}
            </Rows>
          </section>
        ) : null}
      </div>
    </Screen>
  );
}

/** How many of the student's own words to show on the home screen before "and N more". */
const MY_WORDS_SHOWN = 5;

/**
 * The student's own words to work on — theirs alone; the teacher has no view of
 * it. Framed as work to do rather than a record of failure, and it says how the
 * list empties, because a list that only ever grows would be a reason to stop
 * looking at it.
 */
function MyWordsSection({
  data,
  primary,
}: {
  data: MyWordsView;
  /** The page's one accent button — unless a test is open, which outranks it. */
  primary: boolean;
}) {
  const navigate = useNavigate();

  if (data.words.length === 0 && data.cleared === 0) return null;
  const more = data.words.length - MY_WORDS_SHOWN;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <span className="label">Words to work on</span>
        {data.words.length > 0 ? (
          <Button
            variant={primary ? 'primary' : 'secondary'}
            onClick={() => navigate('/s/my-words/drill')}
          >
            Practise them
          </Button>
        ) : null}
      </div>

      {data.words.length === 0 ? (
        <p className="text-lg text-ink-60">
          Nothing left here. {data.cleared} {data.cleared === 1 ? 'word' : 'words'} you once missed,
          you have since got right in a test.
        </p>
      ) : (
        <>
          <p className="max-w-prose text-ink-60">
            Words you missed in a test and have not got right since. A word comes off this list when
            you get it right in a test — so practise it before the next one.
          </p>
          <Rows>
            {data.words.slice(0, MY_WORDS_SHOWN).map((word) => (
              <Row key={word.wordId}>
                <span className="flex-1 text-xl">{word.headwordEn}</span>
                <span className="flex-1 text-xl text-ink-60">{word.translationDe}</span>
                {/* Always present, like the study list, so the columns stay lined up. */}
                <span className="label w-40 shrink-0 text-right">
                  {word.timesMissed > 1 ? `missed ${word.timesMissed}×` : `from ${word.fromTestTitle}`}
                </span>
              </Row>
            ))}
          </Rows>
          {more > 0 || data.cleared > 0 ? (
            <p className="text-sm text-ink-40">
              {[
                more > 0 ? `and ${more} more in practice` : null,
                data.cleared > 0
                  ? `${data.cleared} ${data.cleared === 1 ? 'word' : 'words'} already cleared`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Practising the student's own list, through the same drill as a unit's. */
function MyWordsDrill() {
  const navigate = useNavigate();
  const me = useMe();
  // Waits for who is signed in: starting without it would hand out a round of
  // the whole list and file the result under nobody.
  if (!me) return <Centred><Spinner /></Centred>;
  return (
    <Screen>
      <Drill
        path={student('/my-words/drill')}
        queryKey={['student', 'my-words', 'drill']}
        progressKey={{ studentId: me, list: 'my-words' }}
        heading={<span className="label">Practice · my words</span>}
        action={
          <Button size="sm" variant="quiet" onClick={() => navigate('/s')}>
            Close
          </Button>
        }
      />
    </Screen>
  );
}

function StudyList() {
  const { testId = '' } = useParams();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'text' | 'list'>('text');
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['student', 'words', testId],
    queryFn: () =>
      api.get<{
        title: string;
        words: Array<{
          id: string;
          headwordEn: string;
          translationDe: string;
          repeatedFrom: string | null;
        }>;
        blocks: Block[];
      }>(student(`/tests/${testId}/words`)),
  });

  // A test built from a pasted word list has no text to show.
  const hasText = (data?.blocks.length ?? 0) > 0;
  const showing = hasText ? mode : 'list';

  return (
    <Screen>
      <header className="rule-b flex flex-wrap items-baseline justify-between gap-4 pb-5">
        <span className="label">{data?.title ?? 'Words to learn'}</span>
        <div className="flex items-center gap-6">
          {hasText
            ? (
                [
                  ['text', 'In the text'],
                  ['list', 'Word list'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={cx(
                    'label py-1 transition-colors',
                    showing === value ? '!text-ink border-b-2 border-accent' : 'hover:!text-ink',
                  )}
                >
                  {label}
                </button>
              ))
            : null}
          <Button
            size="sm"
            variant="primary"
            onClick={() => navigate(`/s/tests/${testId}/drill`)}
          >
            Practise
          </Button>
          <Button size="sm" variant="quiet" onClick={() => navigate('/s')}>
            Close
          </Button>
        </div>
      </header>

      {isLoading ? (
        <div className="py-12">
          <Spinner />
        </div>
      ) : showing === 'text' ? (
        <div className="flex flex-col gap-6 py-10">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <p className="text-ink-40">Tap a coloured word to see what it means.</p>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className={cx('label transition-colors', showAll ? '!text-ink' : 'hover:!text-ink')}
            >
              {showAll ? 'Hide translations' : 'Show every translation'}
            </button>
          </div>
          <StudyText blocks={data!.blocks} showAll={showAll} />
        </div>
      ) : (
        <div className="py-10">
          <Rows>
            {(data?.words ?? []).map((word) => (
              <Row key={word.id}>
                <span className="flex-1 text-xl">{word.headwordEn}</span>
                <span className="flex-1 text-xl text-ink-60">{word.translationDe}</span>
                {/* Named, not coloured: the accent means "right answer" here.
                    The slot is always there, empty or not, so the two columns
                    above it stay lined up down the whole list. */}
                <span className="label w-40 shrink-0 text-right">
                  {word.repeatedFrom ? `from ${word.repeatedFrom}` : ''}
                </span>
              </Row>
            ))}
          </Rows>
        </div>
      )}
    </Screen>
  );
}

/** The class's practice screen. The drill itself is shared with the teacher's preview. */
function StudentDrill() {
  const { testId = '' } = useParams();
  const navigate = useNavigate();
  const me = useMe();

  if (!me) return <Centred><Spinner /></Centred>;
  return (
    <Screen>
      <Drill
        path={student(`/tests/${testId}/drill`)}
        queryKey={['student', 'drill', testId]}
        progressKey={{ studentId: me, list: `test:${testId}` }}
        heading={<span className="label">Practice · words</span>}
        action={
          <Button size="sm" variant="quiet" onClick={() => navigate('/s')}>
            Close
          </Button>
        }
      />
    </Screen>
  );
}

/** Start screen (2a): eyebrow, wordmark, one-line summary, one primary action. */
function StartScreen({
  className: klass,
  title,
  poolSize,
  target,
  minutes,
  resuming,
  onStart,
}: {
  className: string;
  title: string;
  poolSize: number;
  target: number;
  minutes: number;
  resuming: boolean;
  onStart: () => void;
}) {
  return (
    <Centred>
      <span className="label">
        {klass} · {title}
      </span>
      <Wordmark size="lg" />
      <p className="text-lg text-ink-60">
        {poolSize} words · answer as many as you can · {minutes} minutes
      </p>
      <p className="max-w-md text-lg text-ink-40">
        {target} correct is a full score. You can go past it.
      </p>
      <Button variant="primary" size="lg" className="mt-4" onClick={onStart}>
        {resuming ? 'Carry on' : 'Start quiz'}
      </Button>
    </Centred>
  );
}

function Sprint({ mode }: { mode: 'graded' | 'practice' }) {
  const { testId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AttemptState | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const { feedback, show, next } = useFlash();

  const home = useQuery({
    queryKey: ['student', 'me'],
    queryFn: () => api.get<StudentHomeView>(student('/me')),
  });

  useEffect(() => {
    let cancelled = false;
    api
      .post<AttemptState>(student(`/tests/${testId}/${mode === 'graded' ? 'start' : 'practice'}`))
      .then((next) => !cancelled && setState(next))
      .catch((err: ApiError) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [testId, mode]);

  const finish = useCallback(
    (attemptId: string) => {
      void queryClient.invalidateQueries({ queryKey: ['student', 'me'] });
      navigate(`/s/attempts/${attemptId}/score`, { replace: true });
    },
    [navigate, queryClient],
  );

  const answer = async (given: string) => {
    if (!state?.question || busy) return;
    setBusy(true);
    setChosen(given);
    setSkipped(given === '');
    try {
      const result = await api.post<{
        feedback: AnswerFeedback;
        question: StudentQuestionView | null;
        attempt: AttemptView;
      }>(student(`/attempts/${state.attempt.id}/answers`), {
        questionId: state.question.id,
        given,
      });

      setRevealed(result.feedback.correctAnswer);
      show(result.feedback, () => {
        setBusy(false);
        setChosen(null);
        setRevealed(null);
        setSkipped(false);
        if (!result.question) {
          finish(result.attempt.id);
          return;
        }
        setState({ attempt: result.attempt, question: result.question });
      });
      setState((prev) => (prev ? { ...prev, attempt: result.attempt } : prev));
    } catch (err) {
      setBusy(false);
      setChosen(null);
      // Running out of time mid-answer is normal, not an error to shout about.
      if (err instanceof ApiError && err.status === 403) finish(state.attempt.id);
      else setError(err instanceof Error ? err.message : String(err));
    }
  };

  const expire = useCallback(() => {
    if (state) finish(state.attempt.id);
  }, [state, finish]);

  if (error) {
    return (
      <Message
        eyebrow="Quiz"
        title="This quiz is not open"
        action={
          <Button variant="primary" onClick={() => navigate('/s')}>
            Back
          </Button>
        }
      >
        {error}
      </Message>
    );
  }
  if (!state) {
    return (
      <Centred>
        <Wordmark size="lg" />
        <Spinner label="Getting ready…" />
      </Centred>
    );
  }

  const { attempt, question } = state;

  if (!started) {
    return (
      <StartScreen
        className={home.data?.className ?? ''}
        title={attempt.testTitle}
        poolSize={attempt.poolSize}
        target={attempt.targetCount}
        minutes={Math.round((attempt.deadlineAt ? attempt.secondsRemaining ?? 0 : 0) / 60) || 5}
        resuming={attempt.reachedIndex > 0}
        onStart={() => setStarted(true)}
      />
    );
  }

  return (
    <Screen className="py-6">
      {/* Quiz top bar (1a): close, progress line, counter. */}
      <header className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-6">
          <button
            type="button"
            onClick={() => finish(attempt.id)}
            aria-label="Hand in and leave"
            className="text-2xl leading-none text-ink-40 transition-colors hover:text-ink"
          >
            ×
          </button>
          <div className="flex items-center gap-5">
            {attempt.deadlineAt ? (
              <Countdown deadlineAt={attempt.deadlineAt} onExpire={expire} />
            ) : (
              // Named, because the word drill is also practice and also untimed.
              <span className="label">Practice · questions</span>
            )}
            <span className="tabular text-sm font-semibold text-ink-40">
              {question ? `${question.index} / ${question.total}` : ''}
            </span>
          </div>
        </div>
        <ProgressLine correct={attempt.correctCount} target={attempt.targetCount} />
      </header>

      <main className="flex flex-1 flex-col justify-center py-10">
        {feedback ? (
          <FeedbackFlash feedback={feedback} skipped={skipped} onNext={next} />
        ) : question ? (
          <QuestionCard
            question={question}
            disabled={busy}
            chosen={chosen}
            correctAnswer={revealed}
            onAnswer={answer}
            onSkip={() => void answer('')}
          />
        ) : (
          <Spinner />
        )}
      </main>
    </Screen>
  );
}

/** Result screen (2b). */
function Score() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['student', 'attempt', attemptId],
    queryFn: () => api.get<AttemptState>(student(`/attempts/${attemptId}`)),
  });

  if (isLoading || !data) return <Centred><Spinner /></Centred>;
  const { attempt } = data;
  const missed = Math.max(0, attempt.reachedIndex - attempt.correctCount);

  return (
    <Screen>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <span className="label">Quiz complete</span>
        {/*
          The brief calls for one huge score. Ours is uncapped, so the percentage
          is the number that carries the achievement — the raw count sits under
          it as meta, in the brief's secondary weight.
        */}
        <p className="text-display font-semibold">{attempt.percent}%</p>
        <p className="text-lg text-ink-60">
          {attempt.correctCount} correct of {attempt.targetCount} needed
          {missed > 0 ? ` · ${missed} missed` : ''}
        </p>
        <ProgressLine
          correct={attempt.correctCount}
          target={attempt.targetCount}
          className="mt-6 max-w-md"
        />
      </div>

      <div className="rule-t flex flex-col items-center gap-4 pt-8">
        <div className="flex justify-center gap-4">
          {/* The answers wait for the test to close, so an early finisher is not
              holding the key while the others are still writing. */}
          {attempt.reviewOpen ? (
            <Button onClick={() => navigate(`/s/attempts/${attempt.id}/review`)}>
              Review answers
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => navigate('/s')}>
            Continue
          </Button>
        </div>
        {!attempt.reviewOpen ? (
          <p className="text-sm text-ink-40">
            You can go through your answers once your teacher closes the test.
          </p>
        ) : null}
      </div>
    </Screen>
  );
}

interface ReviewRow {
  id: string;
  orderIndex: number;
  payload: QuestionPayload;
  correctAnswer: string;
  given: string | null;
  correct: boolean | null;
  reached: boolean;
}

function Review() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['student', 'review', attemptId],
    queryFn: () =>
      api.get<{ attempt: AttemptView; questions: ReviewRow[]; canPractiseWords: boolean }>(
        student(`/attempts/${attemptId}/review`),
      ),
  });

  if (isLoading) return <Centred><Spinner /></Centred>;
  if (error) {
    return (
      <Message
        eyebrow="Review"
        title="Not available yet"
        action={
          <Button variant="primary" onClick={() => navigate('/s')}>
            Back
          </Button>
        }
      >
        {(error as ApiError).message}
      </Message>
    );
  }
  if (!data) return null;

  const promptOf = (payload: QuestionPayload) => {
    switch (payload.type) {
      case 'translate_input':
      case 'mcq_translation':
        return payload.prompt;
      case 'mcq_definition':
        return `“${payload.definition}”`;
      case 'fill_blank':
        return payload.sentence.replace('___', '_______');
    }
  };

  const missed = data.questions.filter((q) => q.reached && q.correct === false);
  const notReached = data.questions.filter((q) => !q.reached);

  return (
    <Screen>
      <header className="rule-b flex items-baseline justify-between pb-5">
        <span className="label">{data.attempt.testTitle}</span>
        <Button size="sm" variant="quiet" onClick={() => navigate('/s')}>
          Close
        </Button>
      </header>

      <div className="flex flex-col gap-10 py-10">
        <p className="max-w-prose text-xl">
          {missed.length === 0
            ? 'Everything you reached was right.'
            : `${missed.length} to learn.`}
          {notReached.length > 0 ? (
            <span className="text-ink-40">
              {' '}
              You did not get to {notReached.length} of them.
            </span>
          ) : null}
        </p>

        <Rows>
          {data.questions.map((row) => {
            const wrong = row.reached && row.correct === false;
            return (
              <Row key={row.id}>
                <span className="tabular w-8 shrink-0 text-sm text-ink-40">
                  {String(row.orderIndex + 1).padStart(2, '0')}
                </span>

                {/* A miss is the thing worth looking at, so it is the only row
                    set at full strength. What you already knew recedes. */}
                <span
                  className={cx(
                    'min-w-40 flex-1 text-lg',
                    wrong ? 'text-ink' : row.reached ? 'text-ink-60' : 'text-ink-40',
                  )}
                >
                  {promptOf(row.payload)}
                </span>

                {wrong ? (
                  <span className="text-lg text-ink-40 line-through">{row.given}</span>
                ) : null}

                <span
                  className={cx(
                    'w-44 shrink-0 text-right text-lg',
                    wrong ? 'font-semibold text-ink' : row.reached ? 'text-ink-60' : 'text-ink-40',
                  )}
                >
                  {row.correctAnswer}
                </span>
              </Row>
            );
          })}
        </Rows>

        {/* Two different things, so they say which is which. The words come
            first: they carry into the next test, where these questions do not. */}
        {/* While a test is running both kinds of practice are refused — each
            shows answers — so neither is offered, rather than a button that
            leads to a closed door. */}
        {data.canPractiseWords ? (
          <div className="flex flex-wrap justify-center gap-4">
            <Button
              variant="primary"
              onClick={() => navigate(`/s/tests/${data.attempt.testId}/drill`)}
            >
              Practise the words
            </Button>
            <Button onClick={() => navigate(`/s/tests/${data.attempt.testId}/practice`)}>
              Try the questions again
            </Button>
          </div>
        ) : (
          <p className="text-center text-sm text-ink-40">
            Practice comes back once everyone has finished.
          </p>
        )}
      </div>
    </Screen>
  );
}

export function StudentApp() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/:token" element={<TokenLogin />} />
      <Route path="/tests/:testId/sprint" element={<Sprint mode="graded" />} />
      <Route path="/tests/:testId/practice" element={<Sprint mode="practice" />} />
      <Route path="/tests/:testId/words" element={<StudyList />} />
      <Route path="/tests/:testId/drill" element={<StudentDrill />} />
      <Route path="/my-words/drill" element={<MyWordsDrill />} />
      <Route path="/attempts/:attemptId/score" element={<Score />} />
      <Route path="/attempts/:attemptId/review" element={<Review />} />
      <Route path="*" element={<Navigate to="/s" replace />} />
    </Routes>
  );
}
