// The trigger handlers only add work to the queue (plan 5.1).
import type { OnPostFlairUpdateRequest, OnPostSubmitRequest } from '@devvit/web/shared';
import { enqueue, loadPost } from './store';

const SKIPPED_RECHECK_MS = 48 * 3_600_000;

export async function onPostSubmit({ post }: OnPostSubmitRequest): Promise<void> {
  if (!post) throw new Error('PostSubmit has no post');
  await enqueue({ kind: 'new', postId: post.id }, Date.now()); // not createdAt of the payload: its unit is checked by S3
}

/** A post that was skipped and is under 48 hours old gets a second look: its flair is the reason that it was skipped, or that it fails (legacy L§1.0). */
export async function onPostFlairUpdate({ post }: OnPostFlairUpdateRequest): Promise<void> {
  if (!post) throw new Error('PostFlairUpdate has no post');
  const rec = await loadPost(post.id);
  if (rec?.status.startsWith('skipped:') && rec.createdAt !== undefined && Date.now() - rec.createdAt < SKIPPED_RECHECK_MS) {
    await enqueue({ kind: 'new', postId: post.id }, Date.now());
  }
}
