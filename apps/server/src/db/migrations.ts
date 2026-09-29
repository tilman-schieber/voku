import type { Db } from './index.js';

/**
 * Append-only. Each entry runs once, in order, tracked by PRAGMA user_version.
 * Never edit a migration that has shipped — add a new one.
 */
export const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE teachers (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE classes (
    id          TEXT PRIMARY KEY,
    teacher_id  TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE students (
    id          TEXT PRIMARY KEY,
    class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE INDEX idx_students_class ON students(class_id);

  CREATE TABLE tests (
    id               TEXT PRIMARY KEY,
    class_id         TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','published','open','closed')),
    source_text      TEXT NOT NULL DEFAULT '',
    direction        TEXT NOT NULL DEFAULT 'de_en'
                       CHECK (direction IN ('de_en','en_de','mixed')),
    duration_seconds INTEGER NOT NULL DEFAULT 300,
    target_count     INTEGER NOT NULL DEFAULT 25,
    mix_json         TEXT NOT NULL DEFAULT '{}',
    report_json      TEXT,
    created_at       TEXT NOT NULL,
    published_at     TEXT,
    opened_at        TEXT,
    closed_at        TEXT
  );
  CREATE INDEX idx_tests_class ON tests(class_id);

  CREATE TABLE test_words (
    id                   TEXT PRIMARY KEY,
    test_id              TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    headword_en          TEXT NOT NULL,
    translation_de       TEXT NOT NULL,
    pos                  TEXT,
    -- orders the sprint and drives the top-N cutoff
    difficulty           INTEGER NOT NULL DEFAULT 5,
    -- independent of difficulty: decides which words become multiple choice
    trickiness           INTEGER NOT NULL DEFAULT 0,
    trickiness_kind      TEXT NOT NULL DEFAULT 'none',
    trickiness_note      TEXT,
    context_sentence     TEXT,
    accepted_en_json     TEXT NOT NULL DEFAULT '[]',
    accepted_de_json     TEXT NOT NULL DEFAULT '[]',
    suits_fill_blank     INTEGER NOT NULL DEFAULT 1,
    suits_definition_mcq INTEGER NOT NULL DEFAULT 1,
    included             INTEGER NOT NULL DEFAULT 1,
    origin               TEXT NOT NULL DEFAULT 'manual'
                           CHECK (origin IN ('ai','manual','repeat')),
    sort_rank            INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_words_test ON test_words(test_id);

  CREATE TABLE questions (
    id           TEXT PRIMARY KEY,
    test_id      TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    word_id      TEXT NOT NULL REFERENCES test_words(id) ON DELETE CASCADE,
    type         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    -- ascending difficulty; identical for every student
    order_index  INTEGER NOT NULL,
    UNIQUE (test_id, word_id)
  );
  CREATE INDEX idx_questions_test ON questions(test_id, order_index);

  CREATE TABLE attempts (
    id              TEXT PRIMARY KEY,
    test_id         TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    mode            TEXT NOT NULL DEFAULT 'graded'
                      CHECK (mode IN ('graded','practice')),
    started_at      TEXT NOT NULL,
    deadline_at     TEXT,
    submitted_at    TEXT,
    reached_index   INTEGER NOT NULL DEFAULT 0,
    correct_count   INTEGER NOT NULL DEFAULT 0,
    -- copied at start, so editing the target later cannot move a past score
    target_snapshot INTEGER NOT NULL,
    -- practice runs are shuffled; null means natural difficulty order
    order_json      TEXT
  );
  CREATE UNIQUE INDEX idx_attempts_graded
    ON attempts(test_id, student_id) WHERE mode = 'graded';
  CREATE INDEX idx_attempts_test ON attempts(test_id);
  CREATE INDEX idx_attempts_student ON attempts(student_id);

  CREATE TABLE answers (
    id          TEXT PRIMARY KEY,
    attempt_id  TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    given_text  TEXT NOT NULL,
    is_correct  INTEGER NOT NULL,
    answered_at TEXT NOT NULL,
    UNIQUE (attempt_id, question_id)
  );
  CREATE INDEX idx_answers_question ON answers(question_id);

  CREATE TABLE jobs (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    test_id     TEXT REFERENCES tests(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'queued',
    progress    INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  `,

  // 2 — more than one teacher: roles and invitations
  `
  ALTER TABLE teachers ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

  -- Whoever was here first keeps working, and keeps the keys.
  UPDATE teachers SET is_admin = 1
   WHERE id = (SELECT id FROM teachers ORDER BY created_at ASC LIMIT 1);

  CREATE TABLE invites (
    id          TEXT PRIMARY KEY,   -- also the token in the invite URL
    email       TEXT NOT NULL,
    is_admin    INTEGER NOT NULL DEFAULT 0,
    invited_by  TEXT REFERENCES teachers(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    accepted_at TEXT,
    accepted_by TEXT REFERENCES teachers(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_invites_email ON invites(email);
  `,

  // 3 — a definition on the word itself, so a worksheet can show one for every
  // word. Until now a definition existed only inside a mcq_definition question,
  // which covers whichever fraction of the list happened to get that format.
  `
  ALTER TABLE test_words ADD COLUMN definition_en TEXT;
  `,

  // 4 — where a repeated word came from. `origin = 'repeat'` said only that a
  // word had been round before; the class is told which unit it came back from,
  // and that needs the test it was taken out of. Plain TEXT rather than a
  // foreign key: if the old test is deleted the label should quietly disappear,
  // not take the word with it.
  `
  ALTER TABLE test_words ADD COLUMN repeated_from TEXT;
  `,

  // 5 — whether multiple choice may go to any word in this test. Off keeps the
  // original rule (traps and the harder words only); on trades the free-guess
  // risk for a test that is not all typing when the text yielded few traps.
  // Per test, because it is a judgement about one class and one text.
  `
  ALTER TABLE tests ADD COLUMN mcq_any_word INTEGER NOT NULL DEFAULT 0;
  `,
];

export function migrate(db: Db): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version]!;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      // PRAGMA does not accept bound parameters.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${version + 1} failed: ${(err as Error).message}`, { cause: err });
    }
  }

  return MIGRATIONS.length;
}
