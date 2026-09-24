import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_MIX,
  QUESTION_TYPES,
  type AchievedMix,
  type DueWord,
  type MixWeights,
  type QuestionType,
  type QuestionView,
  type RepeatCandidate,
  type TestView,
  type WordView,
} from '@voku/shared';
import { ApiError, admin, api, waitForJob } from '../lib/api.ts';
// Types only: pdf.js itself is loaded when a PDF is picked, not with the app.
import type { Pdf } from '../lib/pdf.ts';
import {
  appendText,
  assemble,
  batched,
  pageBatches,
  pageRange,
  scannedPages,
  type PageContent,
} from '../lib/pdf-pages.ts';
import { Drill } from '../components/Drill.tsx';
import { Worksheet } from './Worksheet.tsx';
import type { JobView } from '@voku/shared';
import {
  Button,
  EditableHeading,
  Empty,
  ErrorText,
  Field,
  Input,
  Note,
  Row,
  Rows,
  Select,
  Spinner,
  Status,
  Textarea,
  cx,
} from '../components/ui.tsx';
import { QuestionEditor } from './QuestionEditor.tsx';

const TYPE_LABEL: Record<QuestionType, string> = {
  translate_input: 'Type the translation',
  mcq_translation: 'Multiple choice · translation',
  mcq_definition: 'Multiple choice · definition',
  fill_blank: 'Fill in the blank',
};

/**
 * The order follows the classroom, not the database: build the test, print the
 * sheet, let them revise for a week, then run the five minutes. Publishing lives
 * in Practise rather than Open, because publishing is what starts the revising —
 * it used to sit next to "Open the test", which put a week and five minutes in
 * the same step.
 */
const STEPS = ['Text', 'Words', 'Design', 'Questions', 'Worksheet', 'Practise', 'Open'] as const;

export function Composer() {
  const { testId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);

  const test = useQuery({
    queryKey: ['admin', 'test', testId],
    queryFn: () => api.get<TestView>(admin(`/tests/${testId}`)),
  });

  const llm = useQuery({
    queryKey: ['admin', 'llm'],
    queryFn: () => api.get<{ configured: boolean }>(admin('/settings/llm')),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'test', testId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'words', testId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'questions', testId] });
    // The sheet is built from the words, so it goes stale with them — and the
    // teacher who just filled the gaps looks at the sheet, not the word list.
    void queryClient.invalidateQueries({ queryKey: ['admin', 'worksheet', testId] });
    // Wakes the poller: it stops when nothing is running.
    void queryClient.invalidateQueries({ queryKey: ['admin', 'active-job', testId] });
  };

  const rename = useMutation({
    mutationFn: (title: string) => api.patch(admin(`/tests/${testId}`), { title }),
    onSuccess: () => {
      setBanner(null);
      refresh();
    },
    onError: (error: ApiError) => setBanner(error.message),
  });

  // Polled here, not in a step, so switching steps or reloading rejoins the job.
  const job = useQuery({
    queryKey: ['admin', 'active-job', testId],
    queryFn: () => api.get<{ job: JobView | null }>(admin(`/tests/${testId}/active-job`)),
    refetchInterval: (q) => {
      const j = q.state.data?.job;
      return j && (j.status === 'queued' || j.status === 'running') ? 1500 : false;
    },
  });

  const latest = job.data?.job ?? null;
  const running = latest?.status === 'queued' || latest?.status === 'running' ? latest : null;
  const failed = latest?.status === 'error' ? latest : null;

  // Once per job, including one that finished between two polls.
  const collected = useRef<string | null>(null);
  useEffect(() => {
    if (!latest || latest.status === 'queued' || latest.status === 'running') return;
    if (collected.current === latest.id) return;
    collected.current = latest.id;
    void queryClient.invalidateQueries({ queryKey: ['admin', 'test', testId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'words', testId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'questions', testId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'worksheet', testId] });
  }, [latest, queryClient, testId]);

  const lifecycle = useMutation({
    mutationFn: (action: 'publish' | 'unpublish' | 'open' | 'close') =>
      api.post<TestView>(admin(`/tests/${testId}/${action}`)),
    onSuccess: () => {
      setBanner(null);
      refresh();
    },
    onError: (error: ApiError) => setBanner(error.message),
  });

  if (test.isLoading) return <Spinner />;
  if (!test.data) return null;
  const aiReady = llm.data?.configured === true;

  return (
    <div className="flex flex-col gap-8">
      {/* Chrome: it belongs on the screen, never on a sheet handed to a class. */}
      <div className="no-print flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link
            to={`/admin/classes/${test.data.classId}`}
            className="label transition-colors hover:!text-ink"
          >
            ← {test.data.className}
          </Link>
          {/* Renaming stays available even while the test is open — it is
              cosmetic, and everything that actually shapes the test is locked. */}
          <EditableHeading
            value={test.data.title}
            ariaLabel="Test name"
            onSave={(title) => rename.mutate(title)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Status tone={test.data.status === 'open' ? 'accent' : 'quiet'}>{test.data.status}</Status>
          {(test.data.status === 'open' || test.data.status === 'closed') && (
            <Button size="sm" onClick={() => navigate(`/admin/tests/${testId}/board`)}>
              Live board
            </Button>
          )}
        </div>
      </div>

      <nav className="no-print rule-b flex flex-wrap gap-8 pb-4">
        {STEPS.map((label, index) => (
          <button
            key={label}
            type="button"
            onClick={() => setStep(index)}
            className={cx(
              'label py-1 transition-colors',
              step === index ? '!text-ink border-b-2 border-accent' : 'hover:!text-ink',
            )}
          >
            <span className="tabular">{String(index + 1).padStart(2, '0')}</span> {label}
          </button>
        ))}
      </nav>

      {test.data.status === 'open' ? (
        <Note>
          <b>This test is open.</b> Students are taking it right now, so it cannot be edited. Close
          it from the live board first.
        </Note>
      ) : null}

      {banner ? <ErrorText>{banner}</ErrorText> : null}

      {running ? <JobBanner job={running} /> : null}
      {failed ? (
        <div className="rule-t rule-b flex flex-col gap-2 py-5">
          <span className="label">The AI step did not finish</span>
          <p className="max-w-prose text-ink">{failed.error}</p>
          <p className="text-sm text-ink-40">
            Nothing was lost — try again, pick a different model in Settings, or build the test by
            hand.
          </p>
        </div>
      ) : null}

      {step === 0 ? <TextStep test={test.data} aiReady={aiReady} onDone={refresh} /> : null}
      {step === 1 ? (
        <WordsStep test={test.data} aiReady={aiReady} onDone={refresh} job={running} />
      ) : null}
      {step === 2 ? <DesignStep test={test.data} onDone={refresh} /> : null}
      {step === 3 ? (
        <QuestionsStep test={test.data} aiReady={aiReady} onDone={refresh} job={running} />
      ) : null}
      {step === 4 ? (
        <Worksheet
          testId={test.data.id}
          aiReady={aiReady}
          editable={test.data.status !== 'open'}
          onStarted={refresh}
        />
      ) : null}
      {step === 5 ? (
        <PractiseStep
          test={test.data}
          onAction={(action) => lifecycle.mutate(action)}
          pending={lifecycle.isPending}
        />
      ) : null}
      {step === 6 ? (
        <OpenStep
          test={test.data}
          onAction={(action) => lifecycle.mutate(action)}
          pending={lifecycle.isPending}
        />
      ) : null}

      <div className="no-print rule-t flex justify-between pt-6">
        <Button disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
          Back
        </Button>
        <Button
          variant="primary"
          disabled={step === STEPS.length - 1}
          onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

/** The same job, stated next to the button that started it. */
function JobInline({ job }: { job: JobView }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [job.id]);

  return (
    <span className="flex items-center gap-3 text-sm text-ink-60">
      <span className="size-3 animate-spin rounded-full border border-hairline-strong border-t-accent" />
      {job.total > 0 ? `${job.progress} of ${job.total}` : 'Working'} ·{' '}
      <span className="tabular">
        {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
      </span>
    </span>
  );
}

/** Elapsed time rather than a fake estimate — some models take minutes. */
function JobBanner({ job }: { job: JobView }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [job.id]);

  const label =
    job.kind === 'extract'
      ? 'Reading the text for words worth training'
      : job.kind === 'generate'
        ? 'Writing the questions'
        : job.kind === 'enrich'
          ? 'Writing the definitions and examples'
          : 'Reading the page';

  const pct = job.total > 0 ? Math.round((job.progress / job.total) * 100) : null;

  return (
    <div className="rule-t rule-b flex flex-col gap-3 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-ink">
          {label}
          {pct !== null ? ` — ${job.progress} of ${job.total}` : '…'}
        </span>
        <span className="tabular text-sm text-ink-40">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} elapsed
        </span>
      </div>

      <div className="relative h-px w-full bg-hairline">
        <div
          className={cx('absolute inset-y-0 left-0 bg-accent', pct === null && 'animate-pulse')}
          style={{ width: pct === null ? '100%' : `${pct}%` }}
        />
      </div>

      <p className="text-sm text-ink-40">
        This runs on the server — you can move around, or close the tab and come back.
        {elapsed > 60 ? ' Slower models can take several minutes.' : ''}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1 — the text
// ---------------------------------------------------------------------------

function TextStep({
  test,
  aiReady,
  onDone,
}: {
  test: TestView;
  aiReady: boolean;
  onDone: () => void;
}) {
  const [text, setText] = useState(test.sourceText);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A PDF with picture pages in it. With a model, its text is held back until
  // the teacher decides, so the document can go into the box in page order;
  // `read` keeps what the model returned batch by batch, so a failure keeps the
  // batches before it and the button carries on from where it stopped. With no
  // model, `pdf` is null: the text there is has gone in, and this is only the
  // notice.
  const [scans, setScans] = useState<{
    pdf: Pdf | null;
    pages: PageContent[];
    read: Record<number, string>;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  const heldPdf = scans?.pdf;
  useEffect(() => () => heldPdf?.close(), [heldPdf]);

  const save = useMutation({
    mutationFn: () => api.patch(admin(`/tests/${test.id}`), { sourceText: text }),
    onSuccess: onDone,
  });

  const fail = (err: unknown) => {
    setStatus(null);
    setError(err instanceof Error ? err.message : String(err));
  };

  /** One request to the model, for a handful of page images. */
  const readImages = async (images: string[]): Promise<string> => {
    const { jobId } = await api.post<{ jobId: string }>(admin(`/tests/${test.id}/transcribe`), {
      images,
    });
    return (await waitForJob<{ text: string }>(jobId)).text;
  };

  const transcribe = async (files: File[]) => {
    setError(null);
    setBusy(true);
    setStatus('Reading the page…');
    try {
      const images = await Promise.all(
        files.map(
          (file) =>
            new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(new Error('Could not read that file'));
              reader.readAsDataURL(file);
            }),
        ),
      );
      // Each batch goes into the box as it arrives, so a later failure keeps it.
      let done = 0;
      for (const batch of batched(images)) {
        if (images.length > 1) {
          setStatus(`Reading ${pageRange(done + 1, done + batch.length)} of ${images.length}…`);
        }
        const read = await readImages(batch);
        setText((prev) => appendText(prev, read));
        done += batch.length;
      }
      setStatus('Read it — check the text before going on.');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Pulls the text straight out of the file — no model, no cost, no upload.
   * Only pages that have no text of their own are offered to the model after.
   */
  const readPdf = async (file: File) => {
    setError(null);
    setScans(null);
    setBusy(true);
    setStatus('Opening the PDF…');
    try {
      const { openPdf, readPage } = await import('../lib/pdf.ts');
      const pdf = await openPdf(file);
      const pages: PageContent[] = [];
      for (let page = 1; page <= pdf.pageCount; page++) {
        setStatus(`Reading page ${page} of ${pdf.pageCount}…`);
        pages.push(await readPage(pdf, page));
      }

      const scanned = scannedPages(pages);
      if (!scanned.length) {
        pdf.close();
        setText((prev) => appendText(prev, assemble(pages, {})));
        setStatus(`Read all ${pdf.pageCount} pages — check the text before going on.`);
      } else if (!aiReady) {
        // Nothing here can read a picture, so the text there is is all there will be.
        pdf.close();
        setText((prev) => appendText(prev, assemble(pages, {})));
        setScans({ pdf: null, pages, read: {} });
        setStatus(null);
      } else {
        setScans({ pdf, pages, read: {} });
        setStatus(null);
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** The paid half: picture pages become images and go to the model. */
  const readScannedPages = async () => {
    if (!scans?.pdf) return;
    const { pdf, pages } = scans;
    const read = { ...scans.read };
    const total = pages.length;
    setError(null);
    setBusy(true);
    try {
      const { renderPageImage } = await import('../lib/pdf.ts');
      const todo = scannedPages(pages).filter((n) => !(n in read));
      for (const batch of pageBatches(todo)) {
        const range = pageRange(batch[0]!, batch.at(-1)!);
        setStatus(`Preparing ${range} of ${total}…`);
        const images: string[] = [];
        for (const page of batch) images.push(await renderPageImage(pdf, page));
        setStatus(`Reading ${range} of ${total}…`);
        const result = await readImages(images);
        // The model gives one text per batch; it goes where the first page was.
        batch.forEach((page, i) => (read[page] = i === 0 ? result : ''));
        setScans({ pdf, pages, read: { ...read } });
      }
      setText((prev) => appendText(prev, assemble(pages, read)));
      setScans(null);
      setStatus('Read them — check the text before going on.');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** Takes the text pages, and whatever the model has read so far, without the rest. */
  const skipScannedPages = () => {
    if (!scans) return;
    setText((prev) => appendText(prev, assemble(scans.pages, scans.read)));
    setScans(null);
    setStatus('Added the pages with text — check it before going on.');
  };

  const pictures = scans ? scannedPages(scans.pages) : [];
  const unread = scans ? pictures.filter((n) => !(n in scans.read)).length : 0;
  const textPages = scans ? scans.pages.length - pictures.length : 0;
  // Held text would be lost or land out of order under anything else started now.
  const deciding = busy || Boolean(scans?.pdf);

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="The text"
        hint="Paste whatever you are reading with the class. Students see it too, with the trained words marked. # heading, **bold** and *italic* work; a blank line starts a paragraph."
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-64"
          placeholder="Paste the English text here…"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending || deciding}>
          Save text
        </Button>
        <input
          ref={pdfRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void readPdf(file);
            e.target.value = '';
          }}
        />
        <Button onClick={() => pdfRef.current?.click()} disabled={deciding}>
          Add a PDF
        </Button>
        {aiReady ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void transcribe([...e.target.files]);
                e.target.value = '';
              }}
            />
            <Button onClick={() => fileRef.current?.click()} disabled={deciding}>
              Photograph a page instead
            </Button>
          </>
        ) : null}
        {status ? <span className="text-sm text-ink-60">{status}</span> : null}
      </div>
      <ErrorText>{error}</ErrorText>

      {scans ? (
        <Note>
          <b>
            {textPages === 0
              ? `This PDF is a scan — all ${scans.pages.length} pages are pictures.`
              : `${pictures.length} of these ${scans.pages.length} pages are pictures.`}
          </b>{' '}
          {scans.pdf ? (
            <>
              There is no text in them to take out, so they have to be read by the language model,
              like a photograph. That costs a few cents and takes about a minute per ten pages.
              {textPages > 0 ? ' The text goes in once you have chosen, in page order.' : null}
              <div className="mt-3 flex flex-wrap gap-3">
                <Button onClick={() => void readScannedPages()} disabled={busy}>
                  {`Read ${unread < pictures.length ? 'the remaining ' : ''}${unread} ${unread === 1 ? 'page' : 'pages'} with AI`}
                </Button>
                {textPages > 0 ? (
                  <Button onClick={skipScannedPages} disabled={busy}>
                    {`Use the ${textPages} ${textPages === 1 ? 'page' : 'pages'} with text only`}
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              There is no text in them to take out, and reading a picture needs a language model.
              Add one in Settings, or type the words straight into the Words step.
            </>
          )}
        </Note>
      ) : null}

      {!aiReady ? (
        <Note>
          <b>No language model configured.</b> You can skip this step entirely — go to Words and
          paste a two-column list instead. Everything except gap sentences and English definitions
          works without one.
        </Note>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2 — the word list
// ---------------------------------------------------------------------------

function WordsStep({
  test,
  aiReady,
  onDone,
  job,
}: {
  test: TestView;
  aiReady: boolean;
  onDone: () => void;
  job: JobView | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRepeats, setShowRepeats] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const words = useQuery({
    queryKey: ['admin', 'words', test.id],
    queryFn: () => api.get<WordView[]>(admin(`/tests/${test.id}/words`)),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'words', test.id] });
    onDone();
  };

  const pasteWords = useMutation({
    mutationFn: () => api.post(admin(`/tests/${test.id}/words/paste`), { text: paste }),
    onSuccess: () => {
      setPaste('');
      invalidate();
    },
    onError: (e: ApiError) => setError(e.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, included }: { id: string; included: boolean }) =>
      api.patch(admin(`/tests/${test.id}/words/${id}`), { included }),
    onSuccess: invalidate,
  });

  const setTrap = useMutation({
    mutationFn: ({ id, trickiness }: { id: string; trickiness: number }) =>
      api.patch(admin(`/tests/${test.id}/words/${id}`), { trickiness }),
    onSuccess: invalidate,
  });

  const cutoff = useMutation({
    mutationFn: (keep: number) => api.post(admin(`/tests/${test.id}/cutoff`), { keep }),
    onSuccess: invalidate,
  });

  const startJob = (path: string, body: unknown) => async () => {
    setError(null);
    setBusy('Starting…');
    try {
      await api.post<{ jobId: string }>(admin(`/tests/${test.id}/${path}`), body);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const extract = startJob('extract-words', { level: 'B1' });
  const enrich = startJob('enrich-words', {});

  const list = words.data ?? [];
  const included = list.filter((w) => w.included);
  const sheetReady = included.filter((w) => w.definitionEn && w.contextSentence).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {aiReady ? (
          <Button variant="primary" onClick={extract} disabled={Boolean(busy) || Boolean(job)}>
            Find the words in the text
          </Button>
        ) : null}
        {aiReady && included.length > 0 ? (
          <Button onClick={enrich} disabled={Boolean(busy) || Boolean(job)}>
            Write the missing definitions
          </Button>
        ) : null}
        <Button onClick={() => setShowRepeats((v) => !v)}>Words from an earlier test</Button>
        {job ? <JobInline job={job} /> : busy ? <Spinner label={busy} /> : null}
      </div>
      <ErrorText>{error}</ErrorText>

      {showRepeats ? <RepeatPicker test={test} onImported={invalidate} /> : null}

      <details className="rule-t rule-b py-6">
        <summary className="label cursor-pointer transition-colors hover:!text-ink">
          Paste a word list instead
        </summary>
        <div className="mt-4 flex flex-col gap-3">
          <Field
            label="One pair per line"
            hint="English first, then German — separated by a semicolon, a tab, or a spaced hyphen. The order you paste is taken as easiest-to-hardest."
          >
            <Textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={'receive;bekommen\nthorough;gründlich\nnevertheless;dennoch'}
            />
          </Field>
          <Button
            variant="primary"
            disabled={!paste.trim() || pasteWords.isPending}
            onClick={() => pasteWords.mutate()}
          >
            Add these words
          </Button>
        </div>
      </details>

      {list.length === 0 ? (
        <Empty title="No words yet">
          Find them in the text, or paste a list — whichever is quicker today.
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-ink-60">
              <strong className="text-ink">{included.length}</strong> of {list.length} words in the
              test
            </p>
            <label className="flex items-center gap-3 text-sm">
              <span className="text-ink-60">Keep the hardest</span>
              <input
                type="range"
                min={1}
                max={list.length}
                defaultValue={included.length}
                onMouseUp={(e) => cutoff.mutate(Number((e.target as HTMLInputElement).value))}
                onTouchEnd={(e) => cutoff.mutate(Number((e.target as HTMLInputElement).value))}
                className="w-44 accent-[var(--color-accent)]"
              />
            </label>
          </div>

          <Rows>
            {list.map((word) => (
              <Row
                key={word.id}
                className={cx(!word.included && 'opacity-40')}
                detail={
                  open === word.id ? (
                    <WordSheetFields test={test} word={word} onSaved={invalidate} />
                  ) : null
                }
              >
                <input
                  type="checkbox"
                  checked={word.included}
                  onChange={() => toggle.mutate({ id: word.id, included: !word.included })}
                  className="size-5 accent-[var(--color-accent)]"
                  aria-label={`Include ${word.headwordEn}`}
                />
                <span className="tabular w-6 text-sm text-ink-60">{word.difficulty}</span>
                <button
                  type="button"
                  onClick={() => setOpen((id) => (id === word.id ? null : word.id))}
                  className="min-w-32 flex-1 text-left text-lg hover:underline"
                  aria-expanded={open === word.id}
                >
                  {word.headwordEn}
                </button>
                <span className="min-w-32 flex-1 text-lg text-ink-60">{word.translationDe}</span>
                {/* Plain text, not a colour: the accent is rationed, and this is
                    a note about completeness rather than something to act on. */}
                <span className="w-20 shrink-0 text-right text-xs text-ink-40">
                  {word.definitionEn && word.contextSentence
                    ? 'on the sheet'
                    : word.definitionEn || word.contextSentence
                      ? 'half done'
                      : ''}
                </span>
                {word.origin === 'repeat' ? <Status tone="quiet">repeat</Status> : null}
                {/* Settable by hand: without a model, nothing else flags a trap. */}
                <button
                  type="button"
                  title={
                    word.trickinessNote ??
                    'Mark as a false friend or confusable, so it gets multiple choice'
                  }
                  onClick={() =>
                    setTrap.mutate({ id: word.id, trickiness: word.trickiness >= 2 ? 0 : 3 })
                  }
                  className={cx(
                    'border px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.12em] transition-colors',
                    word.trickiness >= 2
                      ? 'border-accent text-accent'
                      : 'border-hairline text-ink-40 hover:border-ink hover:text-ink',
                  )}
                >
                  trap
                </button>
              </Row>
            ))}
          </Rows>
          <p className="text-sm text-ink-60">
            The number is difficulty, and it sets the order of the sprint — easiest first.
            Multiple choice goes to words that are hard (7 and above) or marked as a trap —
            anywhere else it would just be a free guess. Tap “trap” to mark a false friend.
          </p>
          <p className="text-sm text-ink-60">
            <strong className="text-ink">{sheetReady}</strong> of {included.length} are ready for
            the worksheet — tap a word to write its definition and example yourself.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The two fields the printed sheet needs. Saved on blur rather than with a
 * button: a teacher correcting a list of thirty is tabbing through it, and a
 * Save next to every field would be thirty things not to forget.
 */
function WordSheetFields({
  test,
  word,
  onSaved,
}: {
  test: TestView;
  word: WordView;
  onSaved: () => void;
}) {
  const [definition, setDefinition] = useState(word.definitionEn ?? '');
  const [example, setExample] = useState(word.contextSentence ?? '');

  const save = useMutation({
    mutationFn: (body: { definitionEn?: string; contextSentence?: string }) =>
      api.patch(admin(`/tests/${test.id}/words/${word.id}`), body),
    onSuccess: onSaved,
  });

  return (
    <div className="flex flex-col gap-4 pl-10">
      <Field
        label="Definition, in English"
        hint="Plain English, and without using the word itself — otherwise the sheet gives the answer away."
      >
        <Input
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          onBlur={() =>
            definition !== (word.definitionEn ?? '') && save.mutate({ definitionEn: definition })
          }
          placeholder={`what “${word.headwordEn}” means, in other words`}
        />
      </Field>
      <Field label="Example sentence" hint="One sentence that uses the word, so its meaning is visible.">
        <Input
          value={example}
          onChange={(e) => setExample(e.target.value)}
          onBlur={() =>
            example !== (word.contextSentence ?? '') && save.mutate({ contextSentence: example })
          }
          placeholder={`a sentence with “${word.headwordEn}” in it`}
        />
      </Field>
    </div>
  );
}

/**
 * Words coming back from earlier units.
 *
 * Leads with what is due, because spacing is the point and a teacher should not
 * have to remember which unit a word was last in. Browsing one particular unit
 * stays underneath, for when they already know what they are after.
 *
 * Nothing is carried over until it is ticked. The suggestion is offered afresh
 * for every test, so leaving it alone is always a valid answer.
 */
function RepeatPicker({ test, onImported }: { test: TestView; onImported: () => void }) {
  const [sourceId, setSourceId] = useState<string>('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const dueWords = useQuery({
    queryKey: ['admin', 'due-words', test.id],
    queryFn: () => api.get<DueWord[]>(admin(`/tests/${test.id}/due-words`)),
  });

  const toggle = (wordId: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(wordId)) next.delete(wordId);
      else next.add(wordId);
      return next;
    });

  const sources = useQuery({
    queryKey: ['admin', 'repeat-sources', test.id],
    queryFn: () =>
      api.get<Array<{ id: string; title: string; status: string }>>(
        admin(`/tests/${test.id}/repeat-sources`),
      ),
  });

  const candidates = useQuery({
    queryKey: ['admin', 'repeat-candidates', test.id, sourceId],
    queryFn: () =>
      api.get<RepeatCandidate[]>(
        admin(`/tests/${test.id}/repeat-candidates?fromTestId=${sourceId}`),
      ),
    enabled: Boolean(sourceId),
  });

  const importWords = useMutation({
    // No source test: a pick can span several units at once.
    mutationFn: () =>
      api.post(admin(`/tests/${test.id}/import-words`), { wordIds: [...picked] }),
    onSuccess: () => {
      setPicked(new Set());
      void dueWords.refetch();
      onImported();
    },
  });

  const due = dueWords.data ?? [];
  const overdue = due.filter((word) => word.dueInDays <= 0);

  return (
    <div className="rule-t rule-b flex flex-col gap-8 py-8">
      <div className="flex flex-col gap-4">
        <span className="label">Due to come round again</span>
        {dueWords.isLoading ? (
          <Spinner />
        ) : overdue.length === 0 ? (
          <p className="text-sm text-ink-60">
            {due.length === 0
              ? 'Nothing yet — words appear here once a test that had them has been closed.'
              : 'Nothing is due. The class saw these recently enough that asking again would be early.'}
          </p>
        ) : (
          <>
            <p className="max-w-prose text-sm text-ink-60">
              Words the class met in an earlier unit, longest overdue first. Spacing them out is
              what makes them stick — but nothing is added unless you tick it.
            </p>
            <ul className="max-h-80 overflow-y-auto">
              {overdue.map((word) => (
                <li key={word.wordId} className="rule-t flex flex-wrap items-center gap-4 py-3">
                  <input
                    type="checkbox"
                    checked={picked.has(word.wordId)}
                    onChange={() => toggle(word.wordId)}
                    className="size-5 accent-[var(--color-accent)]"
                    aria-label={`Bring back ${word.headwordEn}`}
                  />
                  <span className="min-w-28 flex-1 text-lg">{word.headwordEn}</span>
                  <span className="min-w-28 flex-1 text-sm text-ink-60">{word.translationDe}</span>
                  <span className="text-sm text-ink-40">
                    {word.fromTestTitle} · {word.daysSince} days ago
                  </span>
                  <span className="tabular w-24 shrink-0 text-right text-sm text-ink-60">
                    {word.correctRate === null ? 'not reached' : `${word.correctRate}% right`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <Field label="Or take words from one particular test">
        <Select value={sourceId} onChange={(e) => setSourceId((e.target as HTMLSelectElement).value)}>
          <option value="">Choose an earlier test…</option>
          {sources.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </Select>
      </Field>

      {candidates.data ? (
        <>
          <p className="text-sm text-ink-60">
            The rate counts only students who actually reached the question — in a sprint most never
            get to the last few, and counting those as wrong would be unfair to the word.
          </p>
          <ul className="max-h-80 overflow-y-auto">
            {candidates.data.map((c) => (
              <li key={c.wordId} className="rule-t flex items-center gap-4 py-3">
                <input
                  type="checkbox"
                  checked={picked.has(c.wordId)}
                  onChange={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      next.has(c.wordId) ? next.delete(c.wordId) : next.add(c.wordId);
                      return next;
                    })
                  }
                  className="size-5 accent-[var(--color-accent)]"
                />
                <span className="flex-1 text-lg">{c.headwordEn}</span>
                <span className="flex-1 text-sm text-ink-60">{c.translationDe}</span>
                <span
                  className={cx(
                    'tabular text-sm',
                    c.correctRate === null ? 'text-ink-40' : 'text-ink-60',
                  )}
                >
                  {c.correctRate === null ? 'not reached' : `${c.correctRate}% right`}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* One button for both lists, since a pick may span several units. */}
      <Button
        variant="primary"
        disabled={picked.size === 0 || importWords.isPending}
        onClick={() => importWords.mutate()}
      >
        Add {picked.size} word{picked.size === 1 ? '' : 's'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3 — the design
// ---------------------------------------------------------------------------

function DesignStep({ test, onDone }: { test: TestView; onDone: () => void }) {
  const [mix, setMix] = useState<MixWeights>(test.mix ?? DEFAULT_MIX);
  const [duration, setDuration] = useState(test.durationSeconds);
  const [target, setTarget] = useState(test.targetCount);
  const [direction, setDirection] = useState(test.direction);

  const save = useMutation({
    mutationFn: () =>
      api.patch(admin(`/tests/${test.id}`), {
        mix,
        durationSeconds: duration,
        targetCount: target,
        direction,
      }),
    onSuccess: onDone,
  });

  const poolTooSmall = test.includedCount > 0 && test.includedCount <= target;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Minutes" hint="The clock starts when each student taps Start.">
          <Input
            type="number"
            min={1}
            max={60}
            value={Math.round(duration / 60)}
            onChange={(e) => setDuration(Math.max(1, Number(e.target.value)) * 60)}
          />
        </Field>
        <Field label="Target = 100%" hint="Getting past this is the point.">
          <Input
            type="number"
            min={1}
            value={target}
            onChange={(e) => setTarget(Math.max(1, Number(e.target.value)))}
          />
        </Field>
        <Field label="Direction">
          <Select
            value={direction}
            onChange={(e) => setDirection((e.target as HTMLSelectElement).value as TestView['direction'])}
          >
            <option value="de_en">German → English (harder)</option>
            <option value="en_de">English → German (easier)</option>
            <option value="mixed">Mixed</option>
          </Select>
        </Field>
      </div>

      {poolTooSmall ? (
        <Note>
          <b>Nobody could score above 100%.</b> There are {test.includedCount} words and the target
          is {target}. Add more words, or lower the target — otherwise the ceiling removes the
          reason to keep going.
        </Note>
      ) : (
        <p className="text-sm text-ink-60">
          {test.includedCount} questions against a target of {target} — a student who answers them
          all scores{' '}
          <strong className="text-ink">
            {target > 0 ? Math.round((test.includedCount / target) * 100) : 0}%
          </strong>
          .
        </p>
      )}

      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl">The mix</h2>
          <p className="text-sm text-ink-60">
            These are preferences, not quotas. Multiple choice only goes to words flagged as traps,
            so if the text has few, you will get fewer — and the next step says so plainly.
          </p>
        </div>
        {QUESTION_TYPES.map((type) => (
          <label key={type} className="flex flex-wrap items-center gap-3">
            <span className="min-w-56 text-lg">{TYPE_LABEL[type]}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={mix[type]}
              onChange={(e) => setMix({ ...mix, [type]: Number(e.target.value) })}
              className="w-52 accent-[var(--color-accent)]"
            />
            <span className="tabular w-10 text-sm text-ink-40">{mix[type]}</span>
          </label>
        ))}
      </div>

      <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
        Save design
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4 — the questions
// ---------------------------------------------------------------------------

function QuestionsStep({
  test,
  aiReady,
  onDone,
  job,
}: {
  test: TestView;
  aiReady: boolean;
  onDone: () => void;
  job: JobView | null;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const data = useQuery({
    queryKey: ['admin', 'questions', test.id],
    queryFn: () =>
      api.get<{ questions: QuestionView[]; report: AchievedMix | null }>(
        admin(`/tests/${test.id}/questions`),
      ),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'questions', test.id] });
    onDone();
  };

  const generate = async (withAi: boolean) => {
    setError(null);
    setBusy(withAi ? 'Starting…' : 'Building the questions…');
    try {
      if (withAi) {
        await api.post<{ jobId: string }>(admin(`/tests/${test.id}/generate-questions`), {});
        onDone();
      } else {
        await api.post(admin(`/tests/${test.id}/generate`));
        invalidate();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(admin(`/tests/${test.id}/questions/${id}`)),
    onSuccess: invalidate,
  });

  const regenerate = useMutation({
    mutationFn: ({ id, type }: { id: string; type?: QuestionType }) =>
      api.post(admin(`/tests/${test.id}/questions/${id}/regenerate`), type ? { type } : {}),
    onSuccess: invalidate,
    onError: (e: ApiError) => setError(e.message),
  });

  const questions = data.data?.questions ?? [];
  const report = data.data?.report;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {aiReady ? (
          <Button
            variant="primary"
            onClick={() => generate(true)}
            disabled={Boolean(busy) || Boolean(job)}
          >
            Write the questions
          </Button>
        ) : null}
        <Button onClick={() => generate(false)} disabled={Boolean(busy) || Boolean(job)}>
          {aiReady ? 'Build without the AI' : 'Build the questions'}
        </Button>
        {job ? <JobInline job={job} /> : busy ? <Spinner label={busy} /> : null}
      </div>
      <ErrorText>{error}</ErrorText>

      {report ? <MixReport report={report} /> : null}

      {questions.length === 0 ? (
        <Empty title="No questions yet">
          One question per word, in order of difficulty — the same order for every student.
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {questions.map((question) => (
            <li key={question.id}>
              <div className="rule-b flex flex-col gap-4 py-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-baseline gap-3">
                    <span className="tabular text-sm text-ink-40">
                      {String(question.orderIndex + 1).padStart(2, '0')}
                    </span>
                    <div>
                      <p className="text-xl font-semibold tracking-tight">{question.headwordEn}</p>
                      <span className="label">{TYPE_LABEL[question.type]}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Select
                      value={question.type}
                      onChange={(e) =>
                        regenerate.mutate({
                          id: question.id,
                          type: (e.target as HTMLSelectElement).value as QuestionType,
                        })
                      }
                      className="min-h-9 w-52 text-sm"
                    >
                      {QUESTION_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {TYPE_LABEL[type]}
                        </option>
                      ))}
                    </Select>
                    {aiReady ? (
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => regenerate.mutate({ id: question.id })}
                      >
                        Rewrite
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => setEditing(editing === question.id ? null : question.id)}
                    >
                      {editing === question.id ? 'Close' : 'Edit'}
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => remove.mutate(question.id)}>
                      Drop
                    </Button>
                  </div>
                </div>

                {editing === question.id ? (
                  <QuestionEditor
                    testId={test.id}
                    question={question}
                    onSaved={() => {
                      setEditing(null);
                      invalidate();
                    }}
                  />
                ) : (
                  <QuestionPreview question={question} />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QuestionPreview({ question }: { question: QuestionView }) {
  const p = question.payload;
  if (p.type === 'translate_input') {
    return (
      <p className="text-ink-60">
        {p.prompt} → <span className="text-ink">{p.accepted.join(' / ')}</span>
      </p>
    );
  }
  if (p.type === 'fill_blank') {
    return (
      <p className="text-ink-60">
        {p.sentence.replace('___', '______')} → <span className="text-ink">{p.accepted[0]}</span>
      </p>
    );
  }
  const prompt = p.type === 'mcq_translation' ? p.prompt : `“${p.definition}”`;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="text-ink">{prompt}</p>
      <ul className="flex flex-wrap gap-2">
        {p.options.map((option, index) => (
          <li
            key={option}
            className={cx(
              'border px-2 py-0.5',
              index === p.correctIndex ? 'border-accent text-accent' : 'border-hairline text-ink-40',
            )}
          >
            {option}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MixReport({ report }: { report: AchievedMix }) {
  return (
    <div className="rule-t rule-b flex flex-col gap-4 py-8">
      <span className="label">What the text actually supported</span>
      <ul className="grid gap-1 sm:grid-cols-2">
        {QUESTION_TYPES.map((type) => (
          <li key={type} className="flex justify-between gap-4 text-sm">
            <span className="text-ink-60">{TYPE_LABEL[type]}</span>
            <span className="tabular">{report.achieved[type]}</span>
          </li>
        ))}
      </ul>
      {report.shortfalls.length > 0 ? (
        <div className="rule-t flex flex-col gap-2 pt-4">
          {report.shortfalls.map((shortfall, index) => (
            <p key={index} className="text-sm text-ink-60">
              <strong>
                {TYPE_LABEL[shortfall.type]}: asked for {shortfall.wanted}, got {shortfall.got}.
              </strong>{' '}
              {shortfall.reason}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6 — the week before: revising
// ---------------------------------------------------------------------------

/**
 * Publishing, and seeing what publishing gives the class.
 *
 * The preview runs the same component the students do, against the same builder
 * and the same marker — a preview that could disagree with the real thing would
 * be worse than none, because it would be believed.
 */
function PractiseStep({
  test,
  onAction,
  pending,
}: {
  test: TestView;
  onAction: (action: 'publish' | 'unpublish' | 'open' | 'close') => void;
  pending: boolean;
}) {
  const [previewing, setPreviewing] = useState(false);
  const live = test.status === 'published' || test.status === 'closed';

  return (
    <div className="flex flex-col gap-6">
      <div className="rule-t rule-b flex flex-col gap-4 py-8">
        <span className="label">{live ? 'Your class can revise' : 'Not shared yet'}</span>
        <p className="max-w-prose text-lg">
          {live
            ? 'They see the word list and can practise it as often as they like — the pairs, not the questions from the test.'
            : 'Publish the word list and it appears on every student’s screen, with a Practise button. Their marks are not affected either way.'}
        </p>
        <p className="max-w-prose text-sm text-ink-40">
          Practising records nothing. You are not told who revised, or how it went — it is there to
          be used without it counting.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        {test.status === 'draft' ? (
          <Button variant="primary" onClick={() => onAction('publish')} disabled={pending}>
            Publish the word list
          </Button>
        ) : null}
        {test.status === 'published' ? (
          <Button onClick={() => onAction('unpublish')} disabled={pending}>
            Take it back
          </Button>
        ) : null}
        <Button onClick={() => setPreviewing((v) => !v)}>
          {previewing ? 'Hide the preview' : 'Try it as they see it'}
        </Button>
      </div>

      {previewing ? (
        <div className="rule-t flex min-h-[32rem] flex-col pt-6">
          <Drill
            path={admin(`/tests/${test.id}/drill`)}
            queryKey={['admin', 'drill', test.id]}
            heading={<span className="label">Preview · nothing is recorded</span>}
            action={
              <Button size="sm" variant="quiet" onClick={() => setPreviewing(false)}>
                Done
              </Button>
            }
          />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7 — opening it
// ---------------------------------------------------------------------------

function OpenStep({
  test,
  onAction,
  pending,
}: {
  test: TestView;
  onAction: (action: 'publish' | 'unpublish' | 'open' | 'close') => void;
  pending: boolean;
}) {
  const ceiling = test.targetCount > 0 ? Math.round((test.questionCount / test.targetCount) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="rule-t rule-b flex flex-col gap-4 py-8">
        <span className="label">Ready?</span>
        <dl className="grid gap-2 sm:grid-cols-2">
          <Stat label="Questions">{test.questionCount}</Stat>
          <Stat label="Target">{test.targetCount}</Stat>
          <Stat label="Time">{Math.round(test.durationSeconds / 60)} minutes</Stat>
          <Stat label="Highest possible">
            <span className={ceiling > 100 ? 'text-ink' : 'text-accent'}>{ceiling}%</span>
          </Stat>
        </dl>
      </div>

      <div className="flex flex-wrap gap-3">
        {/* Publishing lives in Practise now: it starts the revising, which is a
            week's worth of work, not part of the five minutes. */}
        {test.status !== 'open' ? (
          <Button variant="primary" size="lg" onClick={() => onAction('open')} disabled={pending}>
            Open the test
          </Button>
        ) : (
          <Button variant="danger" size="lg" onClick={() => onAction('close')} disabled={pending}>
            Close the test
          </Button>
        )}
      </div>

      <p className="text-sm text-ink-60">
        Publishing shows students the word list to learn from. Opening starts the sprint — the list
        disappears while it runs, and comes back once you close it.
      </p>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rule-b flex justify-between gap-4 py-2">
      <dt className="text-ink-60">{label}</dt>
      <dd className="tabular">{children}</dd>
    </div>
  );
}
