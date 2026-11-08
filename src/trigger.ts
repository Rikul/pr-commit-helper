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
