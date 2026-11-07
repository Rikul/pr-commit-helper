import type { getOctokit } from '@actions/github';
import type { ChangedFile } from './filter';
import { markersIn, REVIEW_MARKER } from './format';

export type Octokit = ReturnType<typeof getOctokit>;

export type RepoRef = {
  owner: string;
  repo: string;
  pull_number: number;
};

export interface PullInfo {
  title: string;
  body: string;
  draft: boolean;
  headSha: string;
  baseRef: string;
  headRef: string;
  url: string;
}

export async function getPull(octokit: Octokit, ref: RepoRef): Promise<PullInfo> {
  const { data } = await octokit.rest.pulls.get(ref);
  return {
    title: data.title,
    body: data.body ?? '',
    draft: Boolean(data.draft),
    headSha: data.head.sha,
    baseRef: data.base.ref,
    headRef: data.head.ref,
    url: data.html_url,
  };
}

export async function listChangedFiles(octokit: Octokit, ref: RepoRef): Promise<ChangedFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, { ...ref, per_page: 100 });
  return files.map((f) => ({
    filename: f.filename,
    previous_filename: f.previous_filename,
    status: f.status,
    patch: f.patch,
  }));
}

export interface PriorActivity {
  /** Fingerprints of findings this action already posted as inline comments. */
  fingerprints: Set<string>;
  /** Whether this action has posted a review on the PR before. */
  hasReview: boolean;
}

export async function getPriorActivity(octokit: Octokit, ref: RepoRef): Promise<PriorActivity> {
  const [comments, reviews] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviewComments, { ...ref, per_page: 100 }),
    octokit.paginate(octokit.rest.pulls.listReviews, { ...ref, per_page: 100 }),
  ]);
  const fingerprints = new Set<string>();
  for (const c of comments) for (const fp of markersIn(c.body ?? '')) fingerprints.add(fp);
  // Findings listed in a review body (outside the diff) carry markers too.
  for (const r of reviews) for (const fp of markersIn(r.body ?? '')) fingerprints.add(fp);
  const hasReview = reviews.some((r) => (r.body ?? '').includes(REVIEW_MARKER));
  return { fingerprints, hasReview };
}

export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: 'RIGHT';
  start_side?: 'RIGHT';
  body: string;
}

export async function createReview(
  octokit: Octokit,
  ref: RepoRef,
  review: { commitId: string; body: string; event: 'COMMENT' | 'REQUEST_CHANGES'; comments: ReviewComment[] },
): Promise<string> {
  const { data } = await octokit.rest.pulls.createReview({
    ...ref,
    commit_id: review.commitId,
    body: review.body,
    event: review.event,
    comments: review.comments,
  });
  return data.html_url;
}
