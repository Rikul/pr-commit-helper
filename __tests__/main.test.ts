import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import type { Octokit } from '../src/github';
import type { LLMProvider } from '../src/llm';
import { reviewPullRequest } from '../src/main';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

const PATCH = '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = a.foo.bar;\n const c = 2;';

function fakeOctokit(opts: { reviewComments?: unknown[]; reviews?: unknown[]; failFirstReview?: boolean } = {}) {
  const created: any[] = [];
  let calls = 0;
  const pulls = {
    get: async () => ({
      data: { title: 'T', body: 'B', draft: false, head: { sha: 'sha1', ref: 'feat' }, base: { ref: 'main' }, html_url: 'u' },
    }),
    listFiles: async () => ({
      data: [
        { filename: 'src/x.ts', status: 'modified', patch: PATCH },
        { filename: 'package-lock.json', status: 'modified', patch: PATCH },
      ],
    }),
    listReviewComments: async () => ({ data: opts.reviewComments ?? [] }),
    listReviews: async () => ({ data: opts.reviews ?? [] }),
    createReview: async (params: any) => {
      calls++;
      if (opts.failFirstReview && calls === 1) throw Object.assign(new Error('Unprocessable'), { status: 422 });
      created.push(params);
      return { data: { html_url: 'https://github.com/o/r/pull/1#review' } };
    },
  };
  const octokit = { rest: { pulls }, paginate: async (fn: any, p: any) => (await fn(p)).data } as unknown as Octokit;
  return { octokit, created };
}

function fakeProvider(findings: unknown[]): LLMProvider & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  return {
    name: 'fake',
    calls,
    async complete(req) {
      calls.push(req);
      return { text: JSON.stringify({ summary: 'Summary.', findings }), model: 'fake-model', inputTokens: 100, outputTokens: 20 };
    },
  };
}

const cfg = (extra: Record<string, string> = {}) =>
  loadConfig((n) => ({ api_key: 'k', github_token: 't', ...extra })[n] ?? '');
const ref = { owner: 'o', repo: 'r', pull_number: 1 };
const bug = { path: 'src/x.ts', line: 2, severity: 'high', category: 'bug', title: 'Possible undefined access', body: 'a.foo may be undefined.' };

describe('reviewPullRequest', () => {
  it('posts one review with inline comments and skips excluded files', async () => {
    const { octokit, created } = fakeOctokit();
    const provider = fakeProvider([bug, { ...bug, line: 99, title: 'Elsewhere', severity: 'low' }]);
    const res = await reviewPullRequest(cfg(), octokit, ref, provider);

    expect(provider.calls[0]!.user).toContain('### File: src/x.ts');
    expect(provider.calls[0]!.user).not.toContain('package-lock.json');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ commit_id: 'sha1', event: 'COMMENT' });
    expect(created[0].comments).toEqual([expect.objectContaining({ path: 'src/x.ts', line: 2, side: 'RIGHT' })]);
    expect(created[0].body).toContain('Findings outside the changed lines');
    expect(created[0].body).toContain('package-lock.json');
    expect(res?.findings).toHaveLength(2);
    expect(res?.reviewUrl).toContain('#review');
  });

  it('does not repeat findings that were already posted', async () => {
    const first = fakeOctokit();
    await reviewPullRequest(cfg(), first.octokit, ref, fakeProvider([bug]));
    const posted = first.created[0];

    const second = fakeOctokit({ reviewComments: [{ body: posted.comments[0].body }], reviews: [{ body: posted.body }] });
    const res = await reviewPullRequest(cfg(), second.octokit, ref, fakeProvider([bug]));
    expect(second.created).toHaveLength(0);
    expect(res?.findings).toHaveLength(0);
    expect(res?.all).toHaveLength(1);
  });

  it('does not repeat a finding the model reworded on a later run', async () => {
    const first = fakeOctokit();
    await reviewPullRequest(cfg(), first.octokit, ref, fakeProvider([bug]));
    const posted = first.created[0];

    const reworded = { ...bug, title: 'a.foo can be undefined here', category: 'reliability', body: 'Different words.' };
    const second = fakeOctokit({ reviewComments: [{ body: posted.comments[0].body }], reviews: [{ body: posted.body }] });
    const res = await reviewPullRequest(cfg(), second.octokit, ref, fakeProvider([reworded]));
    expect(second.created).toHaveLength(0);
    expect(res?.findings).toHaveLength(0);
  });

  it('requests changes for high findings when configured', async () => {
    const { octokit, created } = fakeOctokit();
    await reviewPullRequest(cfg({ review_event: 'REQUEST_CHANGES' }), octokit, ref, fakeProvider([bug]));
    expect(created[0].event).toBe('REQUEST_CHANGES');
  });

  it('falls back to a body-only review when GitHub rejects comments', async () => {
    const { octokit, created } = fakeOctokit({ failFirstReview: true });
    await reviewPullRequest(cfg(), octokit, ref, fakeProvider([bug]));
    expect(created).toHaveLength(1);
    expect(created[0].comments).toEqual([]);
    expect(created[0].body).toContain('Possible undefined access');
  });

  it('respects min_severity and dry_run, but keeps all findings for the failure gate', async () => {
    const { octokit, created } = fakeOctokit();
    const res = await reviewPullRequest(
      cfg({ min_severity: 'critical', dry_run: 'true' }),
      octokit,
      ref,
      fakeProvider([bug]),
    );
    expect(created).toHaveLength(0);
    expect(res?.findings).toHaveLength(0);
    expect(res?.all.map((f) => f.severity)).toEqual(['high']);
  });

  it('reports parts that failed when others succeed', async () => {
    const { octokit } = fakeOctokit();
    let n = 0;
    const provider: LLMProvider = {
      name: 'half',
      async complete() {
        n++;
        if (n > 2) throw new Error('rate limited');
        return { text: JSON.stringify({ summary: 's', findings: [] }), model: 'm' };
      },
    };
    // A tiny budget splits the diff into several parts.
    const res = await reviewPullRequest(cfg({ max_diff_tokens: '20' }), octokit, ref, provider);
    expect(res?.errors.length).toBeGreaterThan(0);
    expect(res?.errors[0]).toMatch(/rate limited/);
  });

  it('retries once when the model returns invalid JSON', async () => {
    const { octokit, created } = fakeOctokit();
    let n = 0;
    const provider: LLMProvider = {
      name: 'flaky',
      async complete() {
        n++;
        return { text: n === 1 ? 'sorry, no json' : JSON.stringify({ summary: 's', findings: [bug] }), model: 'm' };
      },
    };
    await reviewPullRequest(cfg(), octokit, ref, provider);
    expect(n).toBe(2);
    expect(created[0].comments).toHaveLength(1);
  });

  it('labels part summaries by their own part when an earlier part fails', async () => {
    const { octokit, created } = fakeOctokit();
    let n = 0;
    const provider: LLMProvider = {
      name: 'first-fails',
      async complete() {
        n++;
        if (n === 1) throw new Error('timeout');
        return { text: JSON.stringify({ summary: `summary ${n}`, findings: [] }), model: 'm' };
      },
    };
    await reviewPullRequest(cfg({ max_diff_tokens: '20' }), octokit, ref, provider);
    const body: string = created[0].body;
    expect(body).not.toContain('**Part 1:**');
    expect(body).toContain('**Part 2:** summary 2');
    expect(body).toMatch(/part 1\/\d+: timeout/);
  });

  it('fails when every LLM call fails', async () => {
    const { octokit } = fakeOctokit();
    const provider: LLMProvider = {
      name: 'down',
      async complete() {
        throw new Error('boom');
      },
    };
    await expect(reviewPullRequest(cfg(), octokit, ref, provider)).rejects.toThrow(/boom/);
  });
});
