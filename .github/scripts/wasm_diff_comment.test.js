const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  BOT_MARKER,
  MAX_REPORT_BYTES,
  postWasmDiffComment,
  readReport,
  validateCommentTarget,
} = require('./wasm_diff_comment.js');

const repository = { owner: 'Neziahtech', repo: 'streampay' };
const run = {
  id: 100,
  event: 'pull_request',
  head_sha: 'a'.repeat(40),
  repository: { full_name: 'Neziahtech/streampay' },
  head_repository: { full_name: 'contributor/streampay' },
  pull_requests: [{ number: 7 }],
};
const pullRequest = {
  number: 7,
  state: 'open',
  base: { repo: { full_name: 'Neziahtech/streampay' } },
  head: {
    sha: 'a'.repeat(40),
    repo: { full_name: 'contributor/streampay' },
  },
};

function fixture(overrides = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-comment-'));
  const reportPath = path.join(temp, 'report.md');
  fs.writeFileSync(reportPath, `${BOT_MARKER}\nreport`);
  return { temp, reportPath, ...overrides };
}

test('a matching run and current fork PR head is the only accepted target', () => {
  assert.equal(validateCommentTarget(run, pullRequest, repository), 7);
});

test('a non-PR workflow run is rejected', () => {
  assert.throws(() => validateCommentTarget({ ...run, event: 'push' }, pullRequest, repository), /not a pull-request/);
});

test('a run from another repository is rejected', () => {
  assert.throws(() => validateCommentTarget({ ...run, repository: { full_name: 'other/repo' } }, pullRequest, repository), /different repository/);
});

test('a PR targeting another repository is rejected', () => {
  const foreign = { ...pullRequest, base: { repo: { full_name: 'other/repo' } } };
  assert.throws(() => validateCommentTarget(run, foreign, repository), /targets a different repository/);
});

test('a PR from a different head repository is rejected', () => {
  const foreign = { ...pullRequest, head: { ...pullRequest.head, repo: { full_name: 'other/fork' } } };
  assert.throws(() => validateCommentTarget(run, foreign, repository), /head repository/);
});

test('a stale or malformed head SHA is rejected', () => {
  assert.throws(() => validateCommentTarget(run, { ...pullRequest, head: { ...pullRequest.head, sha: 'b'.repeat(40) } }, repository), /head SHA/);
  assert.throws(() => validateCommentTarget({ ...run, head_sha: 'not-a-sha' }, pullRequest, repository), /head SHA/);
});

test('a closed PR is rejected', () => {
  assert.throws(() => validateCommentTarget(run, { ...pullRequest, state: 'closed' }, repository), /no longer open/);
});

test('an artifact PR number cannot redirect the privileged comment', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-comment-target-'));
  const originalCwd = process.cwd();
  const writes = [];
  try {
    fs.mkdirSync(path.join(temp, 'artifacts'));
    fs.writeFileSync(path.join(temp, 'artifacts', 'pr_number'), '999');
    fs.writeFileSync(path.join(temp, 'artifacts', 'wasm_diff_report.md'), `${BOT_MARKER}\nreport`);
    process.chdir(temp);
    const github = {
      rest: {
        pulls: { get: async () => ({ data: pullRequest }) },
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async args => writes.push(args),
        },
      },
      paginate: async (_method, args) => (await github.rest.issues.listComments(args)).data,
    };
    const context = { repo: repository, payload: { workflow_run: run } };
    const core = { warning: () => {} };
    await postWasmDiffComment({ github, context, core });
    assert.deepEqual(writes.map(write => write.issue_number), [7]);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a missing report skips all comment writes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-comment-missing-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(temp);
    const github = {
      rest: {
        pulls: { get: async () => ({ data: pullRequest }) },
        issues: { createComment: async () => assert.fail('must not write a comment') },
      },
    };
    await postWasmDiffComment({
      github,
      context: { repo: repository, payload: { workflow_run: run } },
      core: { warning: () => {} },
    });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('report validation rejects empty, oversized, binary and unmarked content', () => {
  const { temp, reportPath } = fixture();
  try {
    fs.writeFileSync(reportPath, '');
    assert.throws(() => readReport(reportPath), /nonempty/);
    fs.writeFileSync(reportPath, `${BOT_MARKER}\n${'x'.repeat(MAX_REPORT_BYTES)}`);
    assert.throws(() => readReport(reportPath), /at most/);
    fs.writeFileSync(reportPath, `${BOT_MARKER}\n\0binary`);
    assert.throws(() => readReport(reportPath), /valid bot report/);
    fs.writeFileSync(reportPath, 'untrusted report without marker');
    assert.throws(() => readReport(reportPath), /valid bot report/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
