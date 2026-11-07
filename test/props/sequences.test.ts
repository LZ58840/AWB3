// Plan 7.4 "Properties" (the 3.0 subset) and AC20: random sequences of events in both installations keep the invariants.
// The seed is fixed here because heph caches a passing run (a new seed at each run would make the cache lie). CI (app.yml) sets
// AWB_PROPS_SEED to the number of the run, so each CI build tries other sequences. Another seed by hand:
//   AWB_PROPS_SEED=123 npx vitest run test/props       More runs: AWB_PROPS_RUNS=2000 (the default and the CI minimum is 200).
// A failure prints the seed, the path and the shrunk sequence of commands; the same seed repeats it.
import { reddit } from '@devvit/web/server';
import fc from 'fast-check';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { test, HOUR, type Fx } from '../flows/helpers';
import { createSim, type Delivery, type Sim } from '../sim/sim';
import type { Post } from '../sim/world';

const SEED = Number(process.env.AWB_PROPS_SEED ?? 20261207);
const RUNS = Number(process.env.AWB_PROPS_RUNS ?? 200);

const SUBS = ['Animewallpaper', 'AnimePhoneWallpapers'] as const;
type Sub = (typeof SUBS)[number];
const MODES = ['off', 'dry-run', 'enforce'] as const;
type Mode = (typeof MODES)[number];

// All rules on: a small image fails the size rule, flair Art wants vertical images, 3 posts of one author in a day fail the rate
// rule, and a post that passes waits for the source comment (1 hour).
const RULES = {
  resolutionBad: true, minHorizontal: '1920x1080', flairRules: 'Art: vertical\nFree: skip',
  rateLimit: true, rateLimitHours: 24, rateLimitPosts: 2, sourceComment: true, sourceHours: 1,
};
const IMAGES = [[], [{ width: 1600, height: 1200 }], [{ width: 1920, height: 1080 }], [{ width: 900, height: 1600 }], [{ width: 1920, height: 1080 }, { width: 800, height: 600 }]];

const sub = fc.constantFrom(...SUBS);
const delivery = fc.constantFrom<Delivery>('once', 'duplicate', 'reorder', 'drop');
const post = fc.nat(30); // an earlier post, by its place in the list
const flair = fc.constantFrom<string | undefined>('Art', 'Free', 'Other', undefined);
const images = fc.nat(IMAGES.length - 1);
const command = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('submit' as const), sub, author: fc.constantFrom('alice', 'bob', 'carol'), images, flair, delivery }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('filter' as const), sub, images, sendDelete: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('comment' as const), post, own: fc.boolean(), delivery }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('remove' as const), post, delivery }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('delete' as const), post, delivery }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('approve' as const), post }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('flair' as const), post, flair, delivery }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('mode' as const), sub, mode: fc.constantFrom(...MODES) }) },
  // Reddit fails once: the next read of a post, or the next comment. The item retries; three failures in a row stop it (status error).
  { weight: 1, arbitrary: fc.record({ t: fc.constant('fail' as const), what: fc.constantFrom('getPostById', 'submitComment') }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('advance' as const), minutes: fc.constantFrom(1, 2, 3, 5, 15, 61) }) },
);
const scenario = fc.record({ modes: fc.tuple(fc.constantFrom(...MODES), fc.constantFrom(...MODES)), commands: fc.array(command, { minLength: 1, maxLength: 14 }) });
type Scenario = typeof scenario extends fc.Arbitrary<infer S> ? S : never;

type Entry = { postId: string; kind: string; evt: string; action?: string };
const REMOVAL = 'comment,distinguish,lock,remove';

/** The posts that the app must leave alone: approved, deleted by the author, or removed by someone else (a filter keeps a post open). */
const closed = (sim: Sim) =>
  new Set<string>(
    [...sim.world.posts.values()]
      .filter((p) => p.approved || p.removedByCategory === 'deleted' || (p.removed && p.removedBy !== sim.world.app.name && p.removedByCategory !== 'automod_filtered'))
      .map((p) => p.id),
  );

/**
 * The Redis of a run is cleared when the run ends. RedisMock.clear() finds its keys with a SCAN that skips keys while it deletes
 * (ioredis-mock), so it is only reliable while the shared store holds fewer than 100 keys: one run leaves the keys of both
 * installations, never the keys of 200 runs.
 */
const clearRedis = async (installations: { redis: { clear(): Promise<void> } }[]) => {
  for (const { redis } of installations) await redis.clear();
};

/** One run: the commands, then enough time for all the work; the invariants hold after each step and at the end. */
async function run(fx: Fx, { modes, commands }: Scenario) {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined); // an injected failure is logged as an error
  const sim = createSim(app, fx);
  const installations = SUBS.map((name, i) => sim.install(name, { ...RULES, mode: modes[i]! }));
  try {
    return await check(sim, installations, { modes, commands });
  } finally {
    await clearRedis(installations);
  }
}

async function check(sim: Sim, installations: ReturnType<Sim['install']>[], { modes, commands }: Scenario) {
  const mode = new Map<Sub, Mode>(SUBS.map((name, i) => [name, modes[i]!]));
  const posts: Post[] = [];
  let seen = 0;

  // No mutation in dry-run or off; none on a post that was approved, deleted or removed by someone else before the step.
  const step = async (change: () => Promise<unknown>) => {
    const before = closed(sim);
    await change();
    for (const action of sim.world.actions.slice(seen)) {
      const { sub: where } = sim.world.posts.get(action.postId)!;
      expect(before.has(action.postId), `${action.type} on ${action.postId}, which was approved, deleted or removed before`).toBe(false);
      expect(mode.get(where as Sub), `${action.type} on ${action.postId} in ${where}`).toBe('enforce');
    }
    seen = sim.world.actions.length;
  };
  const earlier = (n: number) => posts[n % posts.length];

  for (const cmd of commands) {
    await step(async () => {
      if (cmd.t === 'submit') posts.push(await sim.submit({ sub: cmd.sub, author: cmd.author, flair: cmd.flair, images: IMAGES[cmd.images], delivery: cmd.delivery }));
      else if (cmd.t === 'filter') posts.push(await sim.automodFilter({ sub: cmd.sub, images: IMAGES[cmd.images], sendDelete: cmd.sendDelete }));
      else if (cmd.t === 'mode') {
        installations[SUBS.indexOf(cmd.sub)]!.set({ mode: cmd.mode });
        mode.set(cmd.sub, cmd.mode);
      } else if (cmd.t === 'advance') await sim.advance(`${cmd.minutes}m`);
      else if (cmd.t === 'fail') vi.spyOn(reddit, cmd.what).mockRejectedValueOnce(new Error('HTTP 500'));
      else if (posts.length > 0) {
        const target = earlier(cmd.post)!;
        if (cmd.t === 'comment') await sim.comment(target.id, cmd.own ? target.author : 'dave', 'a comment', { delivery: cmd.delivery });
        else if (cmd.t === 'remove') await sim.modRemove(target.id, { delivery: cmd.delivery });
        else if (cmd.t === 'delete') await sim.userDelete(target.id, { delivery: cmd.delivery });
        else if (cmd.t === 'approve') await sim.approve(target.id);
        else await sim.setFlair(target.id, cmd.flair, { delivery: cmd.delivery });
      }
    });
  }
  // Time for the held events, the sweep, the queue and the source deadlines; the health job runs on the result.
  await step(async () => {
    await sim.advance('6m');
    vi.setSystemTime(Date.now() + 2 * HOUR);
    for (const name of SUBS) for (let i = 0; i < 8; i++) await sim.runJob('tick', { sub: name });
    for (const name of SUBS) await sim.runJob('health', { sub: name });
  });

  let removals = 0;
  let wouldRemovals = 0;
  let sourceDecisions = 0;
  for (const name of SUBS) {
    const keys = await sim.keys(name);
    const audit = (await sim.audit(name)) as Entry[];
    // No cross-installation data: every post that a key or an alert names belongs to this installation.
    const held = [...keys.map((k) => ({ where: k.key, text: `${k.key} ${k.text}` })), ...sim.modmail(name).map((m) => ({ where: m.subject, text: m.bodyMarkdown }))];
    for (const { where, text } of held) for (const id of text.match(/t3_p\d+/g) ?? []) expect(sim.world.posts.get(id as Post['id'])?.sub, `${id} in ${where} of ${name}: ${text.slice(0, 300)}`).toBe(name);
    // No key without a TTL except the queue and the health hash.
    for (const { key, expiresAt } of keys) expect(expiresAt !== undefined || key === 'due' || key === 'health', `${name}: ${key} has no TTL`).toBe(true);
    for (const entry of audit) if (entry.evt === 'decision') {
      wouldRemovals += entry.action === 'would-remove' ? 1 : 0;
      sourceDecisions += entry.kind === 'src' ? 1 : 0;
    }
    for (const p of posts.filter((candidate) => candidate.sub === name)) {
      // Each post gets no call or exactly one removal (1 comment, distinguish, lock, remove); the removal has one audit entry, and the post
      // was first seen in enforce.
      const calls = sim.actions(p.id);
      const types = calls.map(({ type }) => type).join();
      expect(types === '' || types === REMOVAL, `${p.id} in ${name}: ${types}`).toBe(true);
      const audited = audit.filter((e) => e.postId === p.id && e.evt === 'decision' && e.action === 'remove').length;
      expect(audited, `${p.id} in ${name}: audit entries for its removal`).toBe(types === '' ? 0 : 1);
      if (types !== '') {
        removals += 1;
        expect(JSON.parse(keys.find((k) => k.key === `post:${p.id}`)!.text).firstMode, `${p.id}: first mode`).toBe('enforce');
        expect((calls[0] as { text: string }).text, `${p.id}: the comment names its own subreddit`).toContain(`r/${name}!`);
      }
    }
  }
  // Liveness: each post that nothing closed (approved, deleted, removed by others) has a record that says how it ended, also when its trigger was
  // dropped (the sweep finds it) or Reddit failed; and a post that is done has the decision of its `new` item in the audit.
  const stillClosed = closed(sim);
  for (const name of SUBS) {
    const keys = await sim.keys(name);
    const audit = (await sim.audit(name)) as Entry[];
    for (const p of posts.filter((candidate) => candidate.sub === name && !stillClosed.has(candidate.id))) {
      const stored = keys.find((k) => k.key === `post:${p.id}`);
      expect(stored, `${p.id} in ${name} has no record`).toBeDefined();
      const { status } = JSON.parse(stored!.text) as { status: string };
      expect(status, `${p.id} in ${name}: status`).toMatch(/^(?:done|error|skipped:.+)$/);
      if (status === 'done') {
        expect(audit.some((e) => e.postId === p.id && e.kind === 'new' && e.evt === 'decision'), `${p.id} in ${name} is done and has no decision in the audit`).toBe(true);
      }
    }
  }
  return { removals, wouldRemovals, sourceDecisions };
}

test('random sequences keep the invariants in both installations', { timeout: 180_000 }, async (fx) => {
  const seen = { runs: 0, removals: 0, wouldRemovals: 0, sourceDecisions: 0 };
  await fc.assert(
    fc.asyncProperty(scenario, async (input) => {
      const result = await run(fx, input);
      seen.runs += 1;
      seen.removals += result.removals > 0 ? 1 : 0;
      seen.wouldRemovals += result.wouldRemovals > 0 ? 1 : 0;
      seen.sourceDecisions += result.sourceDecisions > 0 ? 1 : 0;
    }),
    { numRuns: RUNS, seed: SEED },
  );
  process.stderr.write(`props: seed ${SEED}, ${JSON.stringify(seen)}\n`);
  // The property is not empty: many runs have a removal by the app, a would-removal of the dry-run, and a decision of the source rule.
  expect(seen.runs).toBe(RUNS);
  for (const [what, runs] of Object.entries({ removals: seen.removals, wouldRemovals: seen.wouldRemovals, sourceDecisions: seen.sourceDecisions })) {
    expect(runs, `runs with ${what}`).toBeGreaterThan(RUNS / 10);
  }
});
