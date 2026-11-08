import { describe, expect, it } from 'vitest';
import { commentTrigger, isCommand, resolveTarget } from '../src/trigger';

const opts = { command: '/review', allowed: ['OWNER', 'MEMBER'] };
const payload = (over: Record<string, unknown> = {}, comment: Record<string, unknown> = {}) => ({
  action: 'created',
  issue: { number: 7, pull_request: { url: 'x' } },
  comment: { id: 99, body: '/review', author_association: 'OWNER', user: { login: 'rikul', type: 'User' }, ...comment },
  ...over,
});

describe('isCommand', () => {
  it('matches the command on the first line only', () => {
    expect(isCommand('/review', '/review')).toBe(true);
    expect(isCommand('  /Review please\nthanks', '/review')).toBe(true);
    expect(isCommand('/reviewer', '/review')).toBe(false);
    expect(isCommand('please /review', '/review')).toBe(false);
    expect(isCommand('looks good\n/review', '/review')).toBe(false);
    expect(isCommand('\n/review', '/review')).toBe(false);
    expect(isCommand('\r\n\r\n/review', '/review')).toBe(false);
    expect(isCommand('/review\r\nplease focus on auth', '/review')).toBe(true);
  });
});

describe('commentTrigger', () => {
  it('reviews when an owner or member comments the command on a PR', () => {
    expect(commentTrigger(payload(), opts)).toEqual({ kind: 'review', pullNumber: 7, commentId: 99 });
    expect(commentTrigger(payload({}, { author_association: 'member' }), opts).kind).toBe('review');
  });

  it('refuses other commenters', () => {
    for (const a of ['COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
      const t = commentTrigger(payload({}, { author_association: a }), opts);
      expect(t.kind).toBe('denied');
    }
    expect(commentTrigger(payload({}, { author_association: 'COLLABORATOR' }), { ...opts, allowed: ['COLLABORATOR'] }).kind).toBe(
      'review',
    );
  });

  it('ignores edits, issues, other comments and bots', () => {
    expect(commentTrigger(payload({ action: 'edited' }), opts).kind).toBe('ignore');
    expect(commentTrigger(payload({ issue: { number: 7 } }), opts).kind).toBe('ignore');
    expect(commentTrigger(payload({}, { body: 'nice work' }), opts).kind).toBe('ignore');
    expect(commentTrigger(payload({}, { user: { login: 'x[bot]', type: 'Bot' } }), opts).kind).toBe('ignore');
  });
});

describe('resolveTarget', () => {
  it('checks comment events even when pr_number is set', () => {
    const outsider = payload({}, { author_association: 'NONE' });
    expect(resolveTarget('issue_comment', outsider, { ...opts, prNumber: 7 })).toMatchObject({ kind: 'skip', notice: true });
    const chatter = payload({}, { body: 'nice work' });
    expect(resolveTarget('issue_comment', chatter, { ...opts, prNumber: 7 })).toMatchObject({ kind: 'skip', notice: false });
    const edited = payload({ action: 'edited' });
    expect(resolveTarget('issue_comment', edited, { ...opts, prNumber: 7 }).kind).toBe('skip');
  });

  it('uses the commented PR for an allowed /review, with on-demand behaviour', () => {
    expect(resolveTarget('issue_comment', payload(), { ...opts, prNumber: 123 })).toEqual({
      kind: 'review',
      pullNumber: 7,
      onDemand: true,
      commentId: 99,
    });
  });

  it('uses the pull_request event or pr_number otherwise', () => {
    expect(resolveTarget('pull_request', { pull_request: { number: 5 } }, opts)).toEqual({
      kind: 'review',
      pullNumber: 5,
      onDemand: false,
    });
    expect(resolveTarget('workflow_dispatch', {}, { ...opts, prNumber: 9 })).toMatchObject({ pullNumber: 9, onDemand: false });
    expect(resolveTarget('push', {}, opts)).toMatchObject({ kind: 'skip', notice: true });
  });
});
