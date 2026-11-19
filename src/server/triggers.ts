// The trigger handlers add work to the queue (plan 5.1); a new post also gets its rate entry here.
import type { OnPostFlairUpdateRequest, OnPostSubmitRequest } from '@devvit/web/shared';
import { NUMBER_SETTINGS } from '../core/config';
import { readConfig } from './settings';
import { enqueue, loadPost, recordRate } from './store';

const SKIPPED_RECHECK_MS = 48 * 3_600_000;

export async function onPostSubmit({ post }: OnPostSubmitRequest): Promise<void> {
  if (!post) throw new Error('PostSubmit has no post');
  await enqueue({ kind: 'new', postId: post.id }, Date.now()); // the queue time; the post time (ms in the payload, S3) is read with the post
  // A post that its author deletes before the tick has no author id to read (S2 (f)), but the payload has it. Mode off keeps no author data (TERMS).
  const { config } = await readConfig();
  if (config.mode !== 'off' && post.authorId) {
    await recordRate(post.authorId, post.id, post.createdAt, (config.rateLimit?.hours ?? NUMBER_SETTINGS.rateLimitHours.def) * 3_600_000);
  }
}

/** A post that was skipped and is under 48 hours old gets a second look: its flair is the reason that it was skipped, or that it fails (legacy L§1.0). */
export async function onPostFlairUpdate({ post }: OnPostFlairUpdateRequest): Promise<void> {
  if (!post) throw new Error('PostFlairUpdate has no post');
  const rec = await loadPost(post.id);
  if (rec?.status.startsWith('skipped:') && rec.createdAt !== undefined && Date.now() - rec.createdAt < SKIPPED_RECHECK_MS) {
    await enqueue({ kind: 'new', postId: post.id }, Date.now());
  }
}
