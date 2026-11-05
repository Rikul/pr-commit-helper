import * as core from '@actions/core';
import * as github from '@actions/github';
import { type Config, loadConfig, severityRank } from './config';
import { chunkDiff, type FileDiff, parsePatch } from './diff';
import { filterFiles } from './filter';
import { dedupe, filterBySeverity, type Finding, parseReview, placeFindings, type PlacedFinding } from './findings';
import { formatComment, formatSummary } from './format';
import {
  createReview,
  getPriorActivity,
  getPull,
  listChangedFiles,
  type Octokit,
  type RepoRef,
  type ReviewComment,
} from './github';
import { createProvider, type LLMProvider } from './llm';
import { FINDINGS_JSON_SCHEMA, systemPrompt, userPrompt } from './prompt';

const CHARS_PER_TOKEN = 4;

export interface ReviewResult {
  findings: PlacedFinding[];
  reviewUrl?: string;
  /** Findings at or above min_severity, including ones posted on earlier runs. */
  current: PlacedFinding[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function reviewChunk(
  provider: LLMProvider,
  system: string,
  user: string,
): Promise<{ summary: string; findings: Finding[]; model: string; inTok: number; outTok: number }> {
  let inTok = 0;
  let outTok = 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? user
        : `${user}\n\nYour previous reply was not valid JSON for the required schema. Reply with only the JSON object.`;
    const res = await provider.complete({ system, user: prompt, schema: FINDINGS_JSON_SCHEMA });
    inTok += res.inputTokens ?? 0;
    outTok += res.outputTokens ?? 0;
    try {
      const parsed = parseReview(res.text);
      if (parsed.invalid) core.warning(`Dropped ${parsed.invalid} malformed finding(s) from the model output.`);
      return { summary: parsed.summary, findings: parsed.findings, model: res.model, inTok, outTok };
    } catch (err) {
      lastErr = err;
      core.debug(`Unparseable model output: ${res.text.slice(0, 2000)}`);
    }
  }
  throw new Error(`Could not parse model output: ${errorMessage(lastErr)}`);
}

export async function reviewPullRequest(
  cfg: Config,
  octokit: Octokit,
  ref: RepoRef,
  provider: LLMProvider,
): Promise<ReviewResult | undefined> {
  const pull = await getPull(octokit, ref);
  if (pull.draft && cfg.skipDraft) {
    core.info('PR is a draft; skipping (set skip_draft: false to review drafts).');
    return undefined;
  }

  const changed = await listChangedFiles(octokit, ref);
  const { selected, skipped } = filterFiles(changed, cfg);
  const files: FileDiff[] = selected.map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename,
    status: f.status,
    hunks: parsePatch(f.patch ?? ''),
  }));
  core.info(`Reviewing ${files.length} file(s); skipped ${skipped.length}.`);
  if (!files.length) {
    core.info('No reviewable files in this PR.');
    return { findings: [], current: [] };
  }

  const chunks = chunkDiff(files, cfg.maxDiffTokens * CHARS_PER_TOKEN);
  const system = systemPrompt(cfg.language, cfg.customInstructions);
  const summaries: string[] = [];
  const raw: Finding[] = [];
  const errors: string[] = [];
  let model = cfg.model;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const [i, diff] of chunks.entries()) {
    core.info(`Calling ${provider.name} (${cfg.model}, effort ${cfg.effort}) for part ${i + 1}/${chunks.length}…`);
    const user = userPrompt({
      repo: `${ref.owner}/${ref.repo}`,
      prNumber: ref.pull_number,
      title: pull.title,
      body: pull.body,
      baseRef: pull.baseRef,
      headRef: pull.headRef,
      language: cfg.language,
      customInstructions: cfg.customInstructions,
      chunkIndex: i,
      chunkCount: chunks.length,
      diff,
    });
    try {
      const r = await reviewChunk(provider, system, user);
      summaries.push(r.summary);
      raw.push(...r.findings);
      model = r.model;
      inputTokens += r.inTok;
      outputTokens += r.outTok;
    } catch (err) {
      const msg = `part ${i + 1}/${chunks.length}: ${errorMessage(err)}`;
      core.warning(`Review failed for ${msg}`);
      errors.push(msg);
    }
  }
  if (errors.length === chunks.length) {
    throw new Error(`The LLM review failed for every part of the diff. ${errors.join('; ')}`);
  }

  const placed = dedupe(placeFindings(raw, files));
  const current = filterBySeverity(placed, cfg.minSeverity);
  const prior = await getPriorActivity(octokit, ref);
  const fresh = current.filter((f) => !prior.fingerprints.has(f.fingerprint));
  const inline = fresh.filter((f) => f.inline);
  const offDiff = fresh.filter((f) => !f.inline);
  core.info(
    `Findings: ${placed.length} total, ${current.length} at/above ${cfg.minSeverity}, ${fresh.length} new (${inline.length} inline).`,
  );

  const summaryInput = {
    summaries: chunks.length > 1 ? summaries.map((s, i) => `**Part ${i + 1}:** ${s}`) : summaries,
    posted: inline,
    offDiff,
    alreadyReported: current.length - fresh.length,
    belowThreshold: placed.length - current.length,
    skippedFiles: skipped,
    errors,
    model,
    effort: cfg.effort,
    inputTokens,
    outputTokens,
  };
  const wantsChanges =
    cfg.reviewEvent === 'REQUEST_CHANGES' && fresh.some((f) => severityRank(f.severity) >= severityRank('high'));
  const event = wantsChanges ? 'REQUEST_CHANGES' : 'COMMENT';
  const comments: ReviewComment[] = inline.map((f) => ({
    path: f.path,
    line: f.line,
    side: 'RIGHT',
    ...(f.start_line !== undefined ? { start_line: f.start_line, start_side: 'RIGHT' as const } : {}),
    body: formatComment(f),
  }));

  if (cfg.dryRun) {
    core.info('dry_run is on; not posting. Review that would be posted:');
    core.info(`--- ${event} ---\n${formatSummary(summaryInput)}`);
    for (const c of comments) core.info(`--- ${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line} ---\n${c.body}`);
    return { findings: fresh, current };
  }

  if (!fresh.length && prior.hasReview && !errors.length) {
    core.info('No new findings since the last review; not posting another one.');
    return { findings: fresh, current };
  }

  let reviewUrl: string;
  try {
    reviewUrl = await createReview(octokit, ref, {
      commitId: pull.headSha,
      body: formatSummary(summaryInput),
      event,
      comments,
    });
  } catch (err) {
    // 422 usually means GitHub rejected a comment position (or REQUEST_CHANGES on
    // the token's own PR). Fall back to a plain review with everything in the body.
    if ((err as { status?: number }).status !== 422) throw err;
    core.warning(`GitHub rejected the review (${errorMessage(err)}); posting findings in the review body instead.`);
    reviewUrl = await createReview(octokit, ref, {
      commitId: pull.headSha,
      body: formatSummary({ ...summaryInput, posted: [], offDiff: [...inline, ...offDiff] }),
      event: 'COMMENT',
      comments: [],
    });
  }
  core.info(`Posted review: ${reviewUrl}`);
  return { findings: fresh, current, reviewUrl };
}

export async function run(): Promise<void> {
  try {
    const cfg = loadConfig();
    core.setSecret(cfg.apiKey);

    const ctx = github.context;
    const pullNumber = cfg.prNumber ?? ctx.payload.pull_request?.number;
    if (!pullNumber) {
      core.notice(
        `No pull request found for event "${ctx.eventName}". Run on pull_request / pull_request_target, or set pr_number.`,
      );
      return;
    }
    if (!cfg.githubToken) throw new Error('Input "github_token" is empty.');

    const octokit = github.getOctokit(cfg.githubToken);
    const ref: RepoRef = { ...ctx.repo, pull_number: pullNumber };
    const result = await reviewPullRequest(cfg, octokit, ref, createProvider(cfg));
    if (!result) return;

    core.setOutput('findings_count', result.findings.length);
    core.setOutput('findings_json', JSON.stringify(result.findings));
    core.setOutput('review_url', result.reviewUrl ?? '');

    if (cfg.failOnSeverity !== 'none') {
      const threshold = severityRank(cfg.failOnSeverity);
      const blocking = result.current.filter((f) => severityRank(f.severity) >= threshold);
      if (blocking.length) {
        core.setFailed(`${blocking.length} finding(s) at or above "${cfg.failOnSeverity}" severity.`);
      }
    }
  } catch (err) {
    core.setFailed(errorMessage(err));
  }
}
