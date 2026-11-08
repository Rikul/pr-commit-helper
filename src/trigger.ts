/** Decides what to do with an `issue_comment` event: run a review, ignore it, or refuse it. */

export type CommentTrigger =
  | { kind: 'review'; pullNumber: number; commentId: number }
  | { kind: 'ignore'; reason: string }
  | { kind: 'denied'; reason: string };

interface CommentPayload {
  action?: string;
  issue?: { number?: number; pull_request?: unknown };
  comment?: { id?: number; body?: string; author_association?: string; user?: { login?: string; type?: string } };
}

/** True when the comment's first line is the command, alone or followed by whitespace/text. */
export function isCommand(body: string, command: string): boolean {
  const first = body.trimStart().split('\n')[0]!.trim().toLowerCase();
  const cmd = command.trim().toLowerCase();
  return first === cmd || first.startsWith(`${cmd} `) || first.startsWith(`${cmd}\t`);
}

export type RunTarget =
  | { kind: 'review'; pullNumber: number; onDemand: boolean; commentId?: number }
  | { kind: 'skip'; reason: string; notice: boolean };

/**
 * Picks the PR to review for this event. Comment events are always checked
 * against the command and allowed commenters first, even when pr_number is
 * set, so an explicit PR number can never bypass that check.
 */
export function resolveTarget(
  eventName: string,
  payload: CommentPayload & { pull_request?: { number?: number } },
  opts: { command: string; allowed: string[]; prNumber?: number },
): RunTarget {
  if (eventName === 'issue_comment') {
    const t = commentTrigger(payload, opts);
    if (t.kind === 'ignore') return { kind: 'skip', reason: t.reason, notice: false };
    if (t.kind === 'denied') return { kind: 'skip', reason: t.reason, notice: true };
    // The comment says which PR it is on; that wins over any pr_number input.
    return { kind: 'review', pullNumber: t.pullNumber, onDemand: true, commentId: t.commentId };
  }
  const pullNumber = opts.prNumber ?? payload.pull_request?.number;
  if (!pullNumber) {
    return {
      kind: 'skip',
      reason: `no pull request found for event "${eventName}". Run on pull_request, pull_request_target or a ${opts.command} comment, or set pr_number`,
      notice: true,
    };
  }
  return { kind: 'review', pullNumber, onDemand: false };
}

export function commentTrigger(
  payload: CommentPayload,
  opts: { command: string; allowed: string[] },
): CommentTrigger {
  const { action, issue, comment } = payload;
  if (action !== 'created') return { kind: 'ignore', reason: `comment ${action ?? 'event'}, not created` };
  if (!issue?.pull_request || !issue.number) return { kind: 'ignore', reason: 'comment is not on a pull request' };
  if (!comment?.id || !isCommand(comment.body ?? '', opts.command)) {
    return { kind: 'ignore', reason: `comment does not start with ${opts.command}` };
  }
  if (comment.user?.type === 'Bot') return { kind: 'ignore', reason: 'comment was written by a bot' };

  const association = (comment.author_association ?? 'NONE').toUpperCase();
  if (!opts.allowed.includes(association)) {
    return {
      kind: 'denied',
      reason: `${comment.user?.login ?? 'commenter'} is ${association}; ${opts.command} is limited to ${opts.allowed.join(', ')}`,
    };
  }
  return { kind: 'review', pullNumber: issue.number, commentId: comment.id };
}
