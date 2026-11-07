// Shared parts of the flow tests (plan 7.4, seams 3 to 5). Each test builds its own simulator around the real Hono app.
import { createDevvitTest, type DevvitFixtures } from '@devvit/test/server/vitest';
import { expect, vi } from 'vitest';
import type { Sim } from '../sim/sim';
import { A1, A2 } from '../core/appendix';

export const test = createDevvitTest();

/** What a test body gets from the harness; a helper that runs a scenario takes it as its first argument. */
export type Fx = Pick<DevvitFixtures, 'config' | 'mocks'>;

/** The installation name of the legacy texts: they say r/Animewallpaper. */
export const SUB = 'Animewallpaper';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const cut = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));

// Pieces of the legacy comments (L Appendix A1 and A2): the pieces are cut from the legacy text, not built by the app code.
const BOT = '\n\n*I am a bot';
export const FLAIR = cut(A2, '\n\n- ', BOT);
export const MISMATCH = cut(A1, '\n\n- **Mismatched', '\n\n- **Bad resolution.**');
export const BAD_RESOLUTION = cut(A1, '\n\n- **Bad resolution.**', '\n\n- **Bad aspect');
export const ASPECT = cut(A1, '\n\n- **Bad aspect', BOT);

/** A removal comment of r/Animewallpaper with these sections: the legacy header, sections and footer. */
export const comment = (...sections: string[]) =>
  (sections.length === 1 ? A2.slice(0, A2.indexOf('\n\n- ')) : A1.slice(0, A1.indexOf('\n\n- '))) +
  sections.join('') +
  A1.slice(A1.indexOf(BOT));

/** The calls of a removal, in the legacy order (plan R9). */
export const REMOVAL = (text: string) => [
  { type: 'comment', commentId: expect.any(String), text },
  { type: 'distinguish', commentId: expect.any(String), sticky: true },
  { type: 'lock' },
  { type: 'remove', spam: false },
];

/** The post record of the app: status, mode and the state of each item. */
export interface PostRecord {
  status: string;
  firstMode: string;
  createdAt?: number;
  items: Record<string, Record<string, unknown>>;
}
export const recordOf = async (sim: Sim, postId: string): Promise<PostRecord | undefined> => {
  const key = (await sim.keys()).find((entry) => entry.key === `post:${postId}`);
  return key && (JSON.parse(key.text) as PostRecord);
};

type Methods = Record<string, (...args: unknown[]) => unknown>;

/** A promise that the test settles by hand. */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** The next call of `target[method]` never returns, like a request that Devvit kills (plan 5.3). The promise settles when the call starts. */
export function killAt(target: object, method: string): Promise<void> {
  const reached = deferred();
  vi.spyOn(target as Methods, method).mockImplementationOnce(() => {
    reached.resolve();
    return new Promise(() => undefined);
  });
  return reached.promise;
}

/** The next call of `target[method]` waits until `release()`; the promise settles when the call starts. */
export function holdAt(target: object, method: string) {
  const reached = deferred();
  const gate = deferred();
  const original = (target as Methods)[method]!.bind(target);
  vi.spyOn(target as Methods, method).mockImplementationOnce((...args: unknown[]) => {
    reached.resolve();
    return gate.promise.then(() => original(...args));
  });
  return { reached: reached.promise, release: gate.resolve };
}

/** The text of the info form that a menu or a form shows (plan 9): one read-only paragraph. */
export const infoText = (response: unknown): string => {
  const { showForm } = response as { showForm: { name: string; form: { title: string; fields: { name: string; defaultValue: string; disabled: boolean }[] } } };
  expect(showForm.name).toBe('info');
  expect(showForm.form.fields).toHaveLength(1);
  expect(showForm.form.fields[0]).toMatchObject({ type: 'paragraph', disabled: true });
  return showForm.form.fields[0]!.defaultValue;
};
