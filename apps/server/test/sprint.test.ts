import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestServer } from './helpers.js';
import { STUDENT_COOKIE } from '../src/middleware/auth.js';

let server: TestServer;
let classId: string;
let testId: string;
let students: Array<{ id: string; name: string; token: string }>;

/** 12 pairs: enough pool to run past a target of 5 and reach 240%. */
const GLOSSARY = [
  'reluctant;widerwillig',
  'thorough;gründlich',
  'scarcely;kaum',
  'ambush;Hinterhalt',
  'nevertheless;dennoch',
  'ruthless;rücksichtslos',
  'diligent;fleißig',
  'obstacle;Hindernis',
  'weary;müde',
  'vivid;lebhaft',
  'sturdy;robust',
  'linger;verweilen',
].join('\n');

async function asTeacher<T>(fn: () => Promise<T>): Promise<T> {
  const studentCookie = server.cookie(STUDENT_COOKIE);
  server.clearCookies();
  await server.post('/api/admin/auth/login', {
    email: 'teacher@school.de',
    password: 'hunter2hunter2',
  });
  const result = await fn();
  server.clearCookies();
  if (studentCookie) await server.post('/api/s/session', { token: studentCookie });
  return result;
}

async function signInStudent(index = 0) {
  server.clearCookies();
  const res = await server.post('/api/s/session', { token: students[index]!.token });
  expect(res.status).toBe(200);
  return res.body;
}

/** Answers the next question correctly, using the payload the student can see. */
async function answerNext(attemptId: string, question: any, correctly = true) {
  const words = await asTeacher(async () =>
    (await server.get(`/api/admin/tests/${testId}/questions`)).body.questions,
  );
  const full = words.find((q: { id: string }) => q.id === question.id);
  let given: string;
  if (full.payload.type === 'mcq_translation' || full.payload.type === 'mcq_definition') {
    given = String(correctly ? full.payload.correctIndex : (full.payload.correctIndex + 1) % 4);
  } else {
    given = correctly ? full.payload.accepted[0] : 'definitely-not-the-answer';
  }
  return server.post(`/api/s/attempts/${attemptId}/answers`, { questionId: question.id, given });
}

beforeEach(async () => {
  server = await TestServer.start();
  await server.signInAsTeacher();

  classId = (await server.post('/api/admin/classes', { name: '9b' })).body.id;
  students = (
    await server.post(`/api/admin/classes/${classId}/students`, {
      names: 'Lena Berger\nTom Weiß\nJonas Ott',
    })
  ).body.added;

  testId = (await server.post('/api/admin/tests', { classId, title: 'Unit 3' })).body.id;
  await server.post(`/api/admin/tests/${testId}/words/paste`, { text: GLOSSARY });
  await server.patch(`/api/admin/tests/${testId}`, {
    targetCount: 5,
    durationSeconds: 300,
    mix: { translate_input: 100, mcq_translation: 0, mcq_definition: 0, fill_blank: 0 },
  });
  await server.post(`/api/admin/tests/${testId}/generate`);
  await server.post(`/api/admin/tests/${testId}/open`);
});

afterEach(async () => {
  await server.stop();
});

describe('signing in with a QR token', () => {
  it('exchanges the token for a cookie', async () => {
    const body = await signInStudent();
    expect(body).toMatchObject({ name: 'Lena Berger', className: '9b' });
    expect(server.cookie(STUDENT_COOKIE)).toBeTruthy();
  });

  it('rejects an unknown token', async () => {
    server.clearCookies();
    expect((await server.post('/api/s/session', { token: 'nope' })).status).toBe(401);
  });

  it('refuses a rotated token, so a leaked code can be revoked', async () => {
    const old = students[0]!.token;
    await server.post(`/api/admin/students/${students[0]!.id}/rotate-token`);
    server.clearCookies();
    expect((await server.post('/api/s/session', { token: old })).status).toBe(401);
  });

  it('requires a session for everything else', async () => {
    server.clearCookies();
    expect((await server.get('/api/s/me')).status).toBe(401);
  });
});

describe('the student home screen', () => {
  it('shows the open test and no study list while it is open', async () => {
    await signInStudent();
    const me = (await server.get('/api/s/me')).body;

    expect(me.className).toBe('9b');
    expect(me.openTests).toHaveLength(1);
    expect(me.openTests[0]).toMatchObject({ title: 'Unit 3', attemptId: null, submitted: false });
    // The word list would be the answer key while the sprint is running.
    expect(me.studyLists).toHaveLength(0);
  });

  it('shows the study list once the test is published but not yet open', async () => {
    await asTeacher(async () => {
      await server.post(`/api/admin/tests/${testId}/close`);
      await server.post(`/api/admin/tests/${testId}/publish`);
    });
    await signInStudent();

    const me = (await server.get('/api/s/me')).body;
    expect(me.studyLists[0]).toMatchObject({ title: 'Unit 3', wordCount: 12 });

    const study = await server.get(`/api/s/tests/${testId}/words`);
    expect(study.body.words).toHaveLength(12);
    expect(study.body.words[0]).toHaveProperty('translationDe');
    // Pasted from a word list, so there is no text to show.
    expect(study.body.blocks).toEqual([]);
  });

  it('refuses the word list while the test is open', async () => {
    await signInStudent();
    expect((await server.get(`/api/s/tests/${testId}/words`)).status).toBe(403);
  });
});

describe('running the sprint', () => {
  it('starts with a server-issued deadline and the first question', async () => {
    await signInStudent();
    const res = await server.post(`/api/s/tests/${testId}/start`);

    expect(res.status).toBe(200);
    expect(res.body.attempt.secondsRemaining).toBeLessThanOrEqual(300);
    expect(res.body.attempt.secondsRemaining).toBeGreaterThan(290);
    expect(res.body.attempt.targetCount).toBe(5);
    expect(res.body.attempt.poolSize).toBe(12);
    expect(res.body.question.index).toBe(1);
    expect(res.body.question.total).toBe(12);
  });

  it('never sends the answer to the student', async () => {
    await signInStudent();
    const res = await server.post(`/api/s/tests/${testId}/start`);
    const serialised = JSON.stringify(res.body.question);

    expect(serialised).not.toContain('accepted');
    expect(serialised).not.toContain('correctIndex');
  });

  it('resumes where the student left off instead of restarting', async () => {
    await signInStudent();
    const started = await server.post(`/api/s/tests/${testId}/start`);
    const attemptId = started.body.attempt.id;
    await answerNext(attemptId, started.body.question);

    // Simulate the iPad dying and the student scanning back in.
    const resumed = await server.post(`/api/s/tests/${testId}/start`);
    expect(resumed.body.attempt.id).toBe(attemptId);
    expect(resumed.body.question.index).toBe(2);
    expect(resumed.body.attempt.correctCount).toBe(1);
  });

  it('gives instant feedback with the correct answer', async () => {
    await signInStudent();
    const started = await server.post(`/api/s/tests/${testId}/start`);

    const wrong = await answerNext(started.body.attempt.id, started.body.question, false);
    expect(wrong.body.feedback.correct).toBe(false);
    expect(wrong.body.feedback.correctAnswer).toBeTruthy();
    expect(wrong.body.question.index).toBe(2);
  });

  it('refuses to answer the same question twice', async () => {
    await signInStudent();
    const started = await server.post(`/api/s/tests/${testId}/start`);
    await answerNext(started.body.attempt.id, started.body.question);

    const again = await answerNext(started.body.attempt.id, started.body.question);
    expect(again.status).toBe(409);
  });

  it('scores past 100% without capping — the whole point of the format', async () => {
    await signInStudent();
    let state = (await server.post(`/api/s/tests/${testId}/start`)).body;
    const attemptId = state.attempt.id;

    // 12 correct answers against a target of 5.
    for (let i = 0; i < 12; i++) {
      const res = await answerNext(attemptId, state.question);
      state = res.body;
    }

    expect(state.attempt.correctCount).toBe(12);
    expect(state.attempt.percent).toBe(240);
  });

  it('ends the sprint when the pool runs out', async () => {
    await signInStudent();
    let state = (await server.post(`/api/s/tests/${testId}/start`)).body;
    for (let i = 0; i < 12; i++) state = (await answerNext(state.attempt.id, state.question)).body;

    expect(state.question).toBeNull();
    expect(state.attempt.submittedAt).toBeTruthy();
  });

  it('rejects answers once the deadline has passed, whatever the device thinks', async () => {
    await signInStudent();
    const started = await server.post(`/api/s/tests/${testId}/start`);
    const attemptId = started.body.attempt.id;

    server.db.run('UPDATE attempts SET deadline_at = :past WHERE id = :id', {
      past: new Date(Date.now() - 1000),
      id: attemptId,
    });

    const late = await answerNext(attemptId, started.body.question);
    expect(late.status).toBe(403);
    expect(late.body.error).toContain('Time is up');
  });

  it('settles an expired attempt automatically on the next read', async () => {
    await signInStudent();
    const started = await server.post(`/api/s/tests/${testId}/start`);
    server.db.run('UPDATE attempts SET deadline_at = :past WHERE id = :id', {
      past: new Date(Date.now() - 1000),
      id: started.body.attempt.id,
    });

    const after = await server.get(`/api/s/attempts/${started.body.attempt.id}`);
    expect(after.body.attempt.submittedAt).toBeTruthy();
    expect(after.body.attempt.secondsRemaining).toBe(0);
    expect(after.body.question).toBeNull();
  });

  it('will not start a test that is not open', async () => {
    await asTeacher(() => server.post(`/api/admin/tests/${testId}/close`));
    await signInStudent();
    expect((await server.post(`/api/s/tests/${testId}/start`)).status).toBe(409);
  });

  it('will not let a student touch another student’s attempt', async () => {
    await signInStudent(0);
    const started = await server.post(`/api/s/tests/${testId}/start`);

    await signInStudent(1);
    expect((await server.get(`/api/s/attempts/${started.body.attempt.id}`)).status).toBe(404);
  });

  it('keeps the score even if the teacher changes the target afterwards', async () => {
    await signInStudent();
    let state = (await server.post(`/api/s/tests/${testId}/start`)).body;
    for (let i = 0; i < 6; i++) state = (await answerNext(state.attempt.id, state.question)).body;
    expect(state.attempt.percent).toBe(120);

    await asTeacher(async () => {
      await server.post(`/api/admin/tests/${testId}/close`);
      await server.patch(`/api/admin/tests/${testId}`, { targetCount: 10 });
    });

    await signInStudent();
    const after = await server.get(`/api/s/attempts/${state.attempt.id}`);
    expect(after.body.attempt.targetCount).toBe(5);
    expect(after.body.attempt.percent).toBe(120);
  });
});

/**
 * Skipping is answering with nothing. A word you do not know otherwise eats the
 * clock while you type something to escape it, and since wrong answers cost no
 * marks, the only thing the old behaviour protected was the typing.
 */
describe('skipping a word', () => {
  it('counts as reached and wrong, and moves on', async () => {
    await signInStudent(0);
    const started = (await server.post(`/api/s/tests/${testId}/start`)).body;

    const res = await server.post(`/api/s/attempts/${started.attempt.id}/answers`, {
      questionId: started.question.id,
      given: '',
    });

    expect(res.status).toBe(200);
    expect(res.body.feedback.correct).toBe(false);
    // The answer still comes back, which is the point of skipping rather than
    // typing rubbish: the word is shown instead of being lost.
    expect(res.body.feedback.correctAnswer).toBeTruthy();
    expect(res.body.attempt.reachedIndex).toBe(1);
    expect(res.body.attempt.correctCount).toBe(0);
    expect(res.body.question.index).toBe(2);
  });

  it('leaves the word on the student’s own list, like any other miss', async () => {
    await signInStudent(0);
    const started = (await server.post(`/api/s/tests/${testId}/start`)).body;
    await server.post(`/api/s/attempts/${started.attempt.id}/answers`, {
      questionId: started.question.id,
      given: '',
    });
    await server.post(`/api/s/attempts/${started.attempt.id}/submit`);
    await asTeacher(() => server.post(`/api/admin/tests/${testId}/close`));

    const mine = await server.get('/api/s/my-words');
    expect(mine.body.words).toHaveLength(1);
  });
});

describe('handing in and reviewing', () => {
  // Handing in shows the score, not the answers: an early finisher would
  // otherwise hold the whole key — unreached questions included — while the
  // rest of the room is still writing. The answers follow when the test closes.
  it('hides the answers until the teacher closes the test, even after handing in', async () => {
    await signInStudent();
    const started = await server.post(`/api/s/tests/${testId}/start`);
    const attemptId = started.body.attempt.id;
    expect((await server.get(`/api/s/attempts/${attemptId}/review`)).status).toBe(403);

    const handedIn = await server.post(`/api/s/attempts/${attemptId}/submit`);
    expect(handedIn.body.attempt.reviewOpen).toBe(false);
    expect((await server.get(`/api/s/attempts/${attemptId}/review`)).status).toBe(403);

    await asTeacher(() => server.post(`/api/admin/tests/${testId}/close`));
    expect((await server.get(`/api/s/attempts/${attemptId}`)).body.attempt.reviewOpen).toBe(true);
    expect((await server.get(`/api/s/attempts/${attemptId}/review`)).status).toBe(200);
  });

  it('distinguishes a wrong answer from a question never reached', async () => {
    await signInStudent();
    let state = (await server.post(`/api/s/tests/${testId}/start`)).body;
    state = (await answerNext(state.attempt.id, state.question, false)).body;
    await server.post(`/api/s/attempts/${state.attempt.id}/submit`);
    await asTeacher(() => server.post(`/api/admin/tests/${testId}/close`));

    const review = (await server.get(`/api/s/attempts/${state.attempt.id}/review`)).body;
    expect(review.questions[0]).toMatchObject({ correct: false, reached: true });
    expect(review.questions[1]).toMatchObject({ correct: null, reached: false });
    expect(review.questions[0].correctAnswer).toBeTruthy();
  });

  it('shows the attempt on the home screen once handed in', async () => {
    await signInStudent();
    let state = (await server.post(`/api/s/tests/${testId}/start`)).body;
    for (let i = 0; i < 3; i++) state = (await answerNext(state.attempt.id, state.question)).body;
    await server.post(`/api/s/attempts/${state.attempt.id}/submit`);

    const me = (await server.get('/api/s/me')).body;
    expect(me.pastAttempts[0]).toMatchObject({ correctCount: 3, targetCount: 5, percent: 60 });
    // It moves out of "ready" — there is nothing left to do with it, and it is
    // listed under what they have finished, with the score.
    expect(me.openTests).toHaveLength(0);
  });
});

describe('closing the test', () => {
  it('hands in every sprint still running', async () => {
    await signInStudent(0);
    const a = await server.post(`/api/s/tests/${testId}/start`);
    await signInStudent(1);
    const b = await server.post(`/api/s/tests/${testId}/start`);

    await asTeacher(() => server.post(`/api/admin/tests/${testId}/close`));

    for (const attemptId of [a.body.attempt.id, b.body.attempt.id]) {
      const row = server.db.get<{ submitted_at: string | null }>(
        'SELECT submitted_at FROM attempts WHERE id = :id',
        { id: attemptId },
      );
      expect(row?.submitted_at).toBeTruthy();
    }
  });
});

describe('practising after the test', () => {
  it('is not available while the test is still open', async () => {
    await signInStudent();
    expect((await server.post(`/api/s/tests/${testId}/practice`)).status).toBe(409);
  });

  it('opens once the test is closed, untimed and shuffled', async () => {
    await asTeacher(() => server.post(`/api/admin/tests/${testId}/close`));
    await signInStudent();

    const res = await server.post(`/api/s/tests/${testId}/practice`);
    expect(res.status).toBe(200);
    expect(res.body.attempt.mode).toBe('practice');
    // No clock: this is drilling, not measuring.
    expect(res.body.attempt.deadlineAt).toBeNull();
    expect(res.body.attempt.secondsRemaining).toBeNull();
    expect(res.body.question).not.toBeNull();
  });

  it('can be run over and over, unlike the graded attempt', async () => {
    await asTeacher(() => server.post(`/api/admin/tests/${testId}/close`));
    await signInStudent();

    const first = (await server.post(`/api/s/tests/${testId}/practice`)).body.attempt.id;
    const second = (await server.post(`/api/s/tests/${testId}/practice`)).body.attempt.id;
    expect(second).not.toBe(first);
  });

  it('does not show up as a graded result on the home screen', async () => {
    await asTeacher(() => server.post(`/api/admin/tests/${testId}/close`));
    await signInStudent();

    let state = (await server.post(`/api/s/tests/${testId}/practice`)).body;
    state = (await answerNext(state.attempt.id, state.question)).body;
    await server.post(`/api/s/attempts/${state.attempt.id}/submit`);

    expect((await server.get('/api/s/me')).body.pastAttempts).toHaveLength(0);
  });

  it('shuffles, so it is not the same run as the graded sprint', async () => {
    await asTeacher(() => server.post(`/api/admin/tests/${testId}/close`));
    await signInStudent();

    const graded = (await server.get(`/api/admin/tests/${testId}/questions`)).body;
    void graded;
    const orders = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await server.post(`/api/s/tests/${testId}/practice`);
      orders.add(res.body.question.id);
    }
    // Across five practice runs the opening question should vary.
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('the teacher’s live board', () => {
  it('lists every student with their state, including those who never started', async () => {
    await signInStudent(0);
    let state = (await server.post(`/api/s/tests/${testId}/start`)).body;
    for (let i = 0; i < 6; i++) state = (await answerNext(state.attempt.id, state.question)).body;

    await signInStudent(1);
    await server.post(`/api/s/tests/${testId}/start`);

    const board = await asTeacher(() => server.get(`/api/admin/tests/${testId}/results`));
    const byName = Object.fromEntries(
      board.body.rows.map((r: { studentName: string }) => [r.studentName, r]),
    );

    expect(board.body.rows).toHaveLength(3);
    expect(byName['Lena Berger']).toMatchObject({
      state: 'in_progress',
      reachedIndex: 6,
      correctCount: 6,
      percent: 120,
    });
    expect(byName['Tom Weiß']).toMatchObject({ state: 'in_progress', reachedIndex: 0 });
    expect(byName['Jonas Ott']).toMatchObject({ state: 'not_started', attemptId: null });
  });

  it('averages only the students who have finished', async () => {
    await signInStudent(0);
    let state = (await server.post(`/api/s/tests/${testId}/start`)).body;
    for (let i = 0; i < 5; i++) state = (await answerNext(state.attempt.id, state.question)).body;
    await server.post(`/api/s/attempts/${state.attempt.id}/submit`);

    const board = await asTeacher(() => server.get(`/api/admin/tests/${testId}/results`));
    expect(board.body.classAveragePercent).toBe(100);
  });

  it('resetting a student’s attempt lets them start clean', async () => {
    await signInStudent(0);
    const started = await server.post(`/api/s/tests/${testId}/start`);
    await answerNext(started.body.attempt.id, started.body.question);

    await asTeacher(() =>
      server.post(`/api/admin/tests/${testId}/attempts/${started.body.attempt.id}/reset`),
    );

    await signInStudent(0);
    const fresh = await server.post(`/api/s/tests/${testId}/start`);
    expect(fresh.body.attempt.id).not.toBe(started.body.attempt.id);
    expect(fresh.body.attempt.correctCount).toBe(0);
    expect(fresh.body.question.index).toBe(1);
  });
});
