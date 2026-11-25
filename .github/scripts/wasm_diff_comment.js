const fs = require('fs');
const path = require('path');

const BOT_MARKER = '<!-- wasm-diff-report -->';
const BOT_LOGIN = 'github-actions[bot]';
const MAX_REPORT_BYTES = 60_000;

function sameRepository(left, right) {
  return typeof left === 'string' && typeof right === 'string' &&
    left.toLowerCase() === right.toLowerCase();
}

function validateCommentTarget(run, pullRequest, repository) {
  if (!run || run.event !== 'pull_request') {
    throw new Error('the workflow run is not a pull-request run');
  }
  const repositoryName = `${repository.owner}/${repository.repo}`;
  if (!run.repository || !sameRepository(run.repository.full_name, repositoryName)) {
    throw new Error('the workflow run belongs to a different repository');
  }
  if (!pullRequest || !Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0) {
    throw new Error('no valid pull request was associated with the workflow run');
  }
  if (!pullRequest.base || !pullRequest.base.repo ||
      !sameRepository(pullRequest.base.repo.full_name, repositoryName)) {
    throw new Error('the pull request targets a different repository');
  }
  if (!run.head_repository || !pullRequest.head || !pullRequest.head.repo ||
      !sameRepository(run.head_repository.full_name, pullRequest.head.repo.full_name)) {
    throw new Error('the pull-request head repository does not match the workflow run');
  }
  if (!/^[0-9a-f]{40}$/i.test(run.head_sha || '') || pullRequest.head.sha !== run.head_sha) {
    throw new Error('the pull-request head SHA does not match the workflow run');
  }
  if (pullRequest.state !== 'open') {
    throw new Error('the pull request is no longer open');
  }
  return pullRequest.number;
}

function readReport(reportPath) {
  const stat = fs.statSync(reportPath);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_REPORT_BYTES) {
    throw new Error(`the Wasm diff report must be a nonempty file of at most ${MAX_REPORT_BYTES} bytes`);
  }
  const body = fs.readFileSync(reportPath, 'utf8');
  if (body.includes('\0') || !body.includes(BOT_MARKER)) {
    throw new Error('the Wasm diff report is not a valid bot report');
  }
  return body;
}

async function postWasmDiffComment({ github, context, core }) {
  const run = context.payload.workflow_run;
  let candidates = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  if (candidates.length === 0) {
    const response = await github.rest.actions.listPullRequestsForRun({
      owner: context.repo.owner,
      repo: context.repo.repo,
      run_id: run.id,
      per_page: 100,
    });
    candidates = response.data;
  }
  if (candidates.length !== 1) {
    core.warning(`Expected one pull request for workflow run ${run.id}, found ${candidates.length}; skipping comment.`);
    return;
  }

  const { data: pullRequest } = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: candidates[0].number,
  });
  const prNumber = validateCommentTarget(run, pullRequest, context.repo);

  const reportPath = path.join('artifacts', 'wasm_diff_report.md');
  if (!fs.existsSync(reportPath)) {
    core.warning(`Report file ${reportPath} not found; skipping PR comment.`);
    return;
  }
  const reportBody = readReport(reportPath);
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const existingComment = comments.find(comment =>
    comment.user && comment.user.login === BOT_LOGIN &&
    typeof comment.body === 'string' && comment.body.includes(BOT_MARKER)
  );

  if (existingComment) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existingComment.id,
      body: reportBody,
    });
    console.log(`Updated existing PR comment ID: ${existingComment.id} on PR #${prNumber}`);
  } else {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      body: reportBody,
    });
    console.log(`Created new PR comment on PR #${prNumber}`);
  }
}

module.exports = {
  BOT_MARKER,
  MAX_REPORT_BYTES,
  postWasmDiffComment,
  readReport,
  validateCommentTarget,
};
