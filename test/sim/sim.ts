// The test API of plan 7.2. It drives the real Hono app through the /internal routes of devvit.json, as Devvit does:
// one POST for each trigger, cron job, menu click, form submit and settings validation, each in a fresh request context.
// Example, inside a createDevvitTest body (`fx` is the fixture object of the test):
//   const sim = createSim(app, fx);
//   sim.install('animewallpaper', { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' });
//   const post = await sim.submit({ title: 'Sunset', flair: 'Desktop', images: [{ width: 800, height: 600 }] });
//   await sim.advance('2m');
//   expect(sim.actions(post.id).map(({ type }) => type)).toEqual(['comment', 'distinguish', 'lock', 'remove']);
// Guesses that S3 checks: a trigger or cron request has no user headers; a menu, form and validation request has the
// moderator; a cron body is {name} (plus the `data` of devvit.json); a select setting reaches the app as an array.
import { randomUUID } from 'node:crypto';
import { RedisAPIDefinition } from '@devvit/protos/types/devvit/plugin/redis/redisapi.js';
import { SettingsDefinition } from '@devvit/protos/types/devvit/plugin/settings/v1alpha/settings.js';
import { RedisMock } from '@devvit/redis/test';
import { SettingsMock } from '@devvit/settings/test';
import type { DevvitFixtures } from '@devvit/test/server/vitest';
import { Context, context, runWithContext } from '@devvit/web/server';
import type { T3 } from '@devvit/web/shared';
import Redis from 'ioredis-mock';
import { onTestFinished } from 'vitest';
import devvitJson from '../../devvit.json';
import type { Cdn } from './cdn';
import { createClock, scheduleOf } from './clock';
import { spyRedis, type RedisSpy } from './redis-spy';
import { createWorld, type NewPost, type Post, type WorldEvent } from './world';

interface Setting {
  type: string;
  defaultValue?: unknown;
  options?: { value: string }[];
  validationEndpoint?: string;
}
interface DevvitJson {
  name: string;
  triggers: Record<string, string>;
  scheduler: { tasks: Record<string, string | { endpoint: string; cron?: string; data?: unknown }> };
  menu: { items: { label: string; location: string | string[]; endpoint: string }[] };
  forms: Record<string, string>;
  settings: { subreddit: Record<string, Setting> };
}
const devvit = devvitJson as DevvitJson;

/** What the simulator needs of the Hono app. */
export interface App {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  routes?: { method: string; path: string }[];
}

/** `once` (default); `duplicate`: sent twice; `drop`: never sent (the sweep must find the post); `reorder`: held back until the next event or advance. */
export type Delivery = 'once' | 'duplicate' | 'drop' | 'reorder';
export type Settings = Record<string, string | number | boolean>;
export type SubmitOptions = Omit<Partial<NewPost>, 'images'> & {
  /** The installation; the first one by default. */
  sub?: string;
  /** With `bytes`, the fake CDN serves the image at its URL (create the simulator with `{ cdn }`). */
  images?: (NonNullable<NewPost['images']>[number] & { bytes?: Uint8Array })[];
  delivery?: Delivery;
};

type Value = string | number | boolean | string[];

interface Installation {
  name: string;
  id: string;
  redis: RedisMock;
  settings: SettingsMock;
  spy: RedisSpy;
  /** Changes install settings; the same checks as install(). */
  set(values: Settings): void;
}

/** The value that the app reads: Devvit gives a select as an array of the chosen options (SettingsClient.flattenFormFieldValue). */
function encode(values: Settings): [string, Value][] {
  return Object.entries(values).map(([key, value]) => {
    const setting = devvit.settings.subreddit[key];
    if (!setting) throw new Error(`unknown setting "${key}": it is not in devvit.json`);
    if (setting.type === 'select') {
      const options = setting.options!.map((option) => option.value);
      if (!options.includes(value as string)) throw new Error(`setting "${key}": "${value}" is not one of ${options.join(', ')}`);
      return [key, [value as string]];
    }
    const expected = setting.type === 'paragraph' ? 'string' : setting.type;
    if (typeof value !== expected) throw new Error(`setting "${key}" must be a ${expected}`);
    return [key, value];
  });
}

export function createSim(app: App, fx: Pick<DevvitFixtures, 'config' | 'mocks'>, { start, cdn }: { start?: number; cdn?: Cdn } = {}) {
  const world = createWorld({ appName: devvit.name });
  const installations = new Map<string, Installation>();
  const requests: { path: string; calls: number }[] = [];
  const held: WorldEvent[] = [];

  const installation = (name?: string): Installation => {
    const found = name ? installations.get(name) : installations.values().next().value;
    if (!found) throw new Error(name ? `subreddit "${name}" is not installed` : 'install a subreddit first: sim.install(name, settings)');
    return found;
  };
  const modOf = (inst: Installation) => world.subs.get(inst.name)!.mods[0]!;
  const postOf = (id: string) => {
    const post = world.posts.get(id as T3);
    if (!post) throw new Error(`no post ${id}`);
    return post;
  };

  // Redis and settings belong to an installation: route them by the subreddit of the request (S1.13).
  world.install(fx, (definition) => {
    const inst = installations.get(context.subredditName!);
    if (definition.fullName === RedisAPIDefinition.fullName) return inst?.redis.plugin;
    if (definition.fullName === SettingsDefinition.fullName) return inst?.settings.plugin;
    return undefined;
  });

  const headers = (inst: Installation, who: { user?: string; postId?: string } = {}) => ({
    'devvit-app': devvit.name,
    'devvit-version': '0.0.0-sim',
    'devvit-app-user': world.app.id,
    'devvit-subreddit': inst.id,
    'devvit-subreddit-name': inst.name,
    ...(who.user ? { 'devvit-user': world.addUser(who.user).id, 'devvit-user-name': who.user } : {}),
    ...(who.postId ? { 'devvit-post': who.postId } : {}),
  });

  /** One POST in a fresh request context. A status other than 200 is an error. */
  async function request(inst: Installation, path: string, body: unknown, who?: { user?: string; postId?: string }): Promise<unknown> {
    const hdrs = headers(inst, who);
    const { result: res, calls } = await inst.spy.measure(async () =>
      runWithContext(Context(hdrs), async () => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...hdrs }, body: JSON.stringify(body) })),
    );
    const text = await res.text();
    requests.push({ path, calls });
    if (res.status !== 200) {
      const hint = res.status === 404 ? 'devvit.json lists this endpoint but the app does not serve it; sim.unrouted() lists all such endpoints' : 'an error of the route is in the console output';
      throw new Error(`POST ${path} gave ${res.status}: ${text} (${hint})`);
    }
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      throw new Error(`POST ${path}: the response is not JSON, and Devvit needs JSON: ${text}`);
    }
  }

  // A trigger that devvit.json does not register is not sent; Reddit does not send it either.
  const deliver = async ({ trigger, sub, body }: WorldEvent) => {
    const path = devvit.triggers[trigger];
    const inst = installations.get(sub);
    if (path && inst) await request(inst, path, body);
  };
  const release = async () => {
    while (held.length) await deliver(held.shift()!);
  };
  /** The follow-up events of the app (its comment, its removal) arrive after the request that made them, and may make more. */
  async function settle() {
    for (let round = 0; ; round++) {
      const events = world.drain();
      if (!events.length) return;
      if (round >= 50) throw new Error(`events keep coming after ${round} rounds: the app seems to answer its own events in a loop`);
      for (const event of events) await deliver(event);
    }
  }
  /** Sends the events that the last change of the world made. */
  async function send(delivery: Delivery = 'once') {
    const events = world.drain();
    if (delivery === 'drop') return;
    if (delivery === 'reorder') {
      held.push(...events);
      return;
    }
    for (const event of delivery === 'duplicate' ? events.flatMap((e) => [e, e]) : events) await deliver(event);
    await release();
    await settle();
  }

  const clock = createClock({
    start,
    tasks: scheduleOf(devvit),
    run: async (task) => {
      for (const inst of installations.values()) {
        await request(inst, task.endpoint, { name: task.name, ...(task.data !== undefined ? { data: task.data } : {}) });
        await settle();
      }
    },
  });

  function create({ sub, delivery: _, images, ...rest }: SubmitOptions): Post {
    const inst = installation(sub);
    if (!cdn && images?.some((image) => image.bytes)) throw new Error('pass { cdn } to createSim to serve image bytes');
    const post = world.addPost({ author: 'alice', title: 'Wallpaper', ...rest, sub: inst.name, ...(images ? { images } : {}) });
    images?.forEach(({ bytes }, i) => {
      const url = post.gallery[i]?.url;
      if (bytes && url) cdn!.serve(url, bytes);
    });
    return post;
  }

  const checked = (path: string, response: unknown) => {
    const name = (response as { showForm?: { name?: string } } | undefined)?.showForm?.name;
    if (name !== undefined && !(name in devvit.forms)) throw new Error(`${path}: form "${name}" is not in devvit.json forms`);
    return response;
  };

  const endpointOf = (task: string | { endpoint: string }) => (typeof task === 'string' ? task : task.endpoint);

  return {
    world,

    /** Installs the app in a subreddit with the install settings. The first installation is the harness world. */
    install(name: string, values: Settings = {}): Installation {
      if (installations.has(name)) throw new Error(`subreddit "${name}" is already installed`);
      encode(values); // a wrong setting is an error before anything changes
      const first = installations.size === 0;
      const sub = world.addSub(name);
      const redis = first ? fx.mocks.redis : new RedisMock(new Redis(), randomUUID());
      const settings = first ? fx.mocks.settings : new SettingsMock();
      if (!first) onTestFinished(() => redis.clear());
      // The app reads the defaults of devvit.json for the settings that nobody saved.
      for (const [key, setting] of Object.entries(devvit.settings.subreddit)) if ('defaultValue' in setting) settings.put(key, setting.defaultValue as Value);
      const set = (more: Settings) => encode(more).forEach(([key, value]) => settings.put(key, value));
      const inst: Installation = { name, id: sub.id, redis, settings, spy: spyRedis(redis), set };
      set(values);
      installations.set(name, inst);
      return inst;
    },

    /** A user submits a post. */
    async submit(options: SubmitOptions = {}): Promise<Post> {
      const post = create(options);
      await send(options.delivery);
      return post;
    },

    /** A user comments on a post. */
    async comment(postId: T3, author: string, body: string, { delivery }: { delivery?: Delivery } = {}) {
      const comment = world.addComment({ postId, author, body });
      await send(delivery);
      return comment;
    },

    async modRemove(postId: T3, { mod, spam, delivery }: { mod?: string; spam?: boolean; delivery?: Delivery } = {}) {
      world.modRemove(postId, mod ?? modOf(installation(postOf(postId).sub)), { spam });
      await send(delivery);
    },

    /** A user submits a post that AutoModerator holds at once. It sends PostDelete only with `sendDelete` (S2 (g)). */
    async automodFilter({ sendDelete, ...options }: SubmitOptions & { sendDelete?: boolean } = {}): Promise<Post> {
      const post = create(options);
      world.automodFilter(post.id, { sendDelete });
      await send(options.delivery);
      return post;
    },

    async userDelete(postId: T3, { delivery }: { delivery?: Delivery } = {}) {
      world.userDelete(postId);
      await send(delivery);
    },

    async approve(postId: T3, { mod }: { mod?: string } = {}) {
      world.approve(postId, mod ?? modOf(installation(postOf(postId).sub)));
    },

    /** `by` changes the flair; the post author by default. */
    async setFlair(postId: T3, flair: string | undefined, { by, delivery }: { by?: string; delivery?: Delivery } = {}) {
      world.setFlair(postId, flair, by ?? postOf(postId).author);
      await send(delivery);
    },

    /**
     * The legacy bot acts like the old AWB: `remove` = sticky comment, lock, remove; `report` = sticky comment, remove the
     * comment, report the post.
     */
    async legacyAct(postId: T3, action: 'remove' | 'report', { text = `Legacy bot: ${action}.`, delivery }: { text?: string; delivery?: Delivery } = {}) {
      const by = world.legacy.name;
      const comment = world.addComment({ postId, author: by, body: text });
      world.distinguish(comment.id, by, true);
      if (action === 'remove') {
        world.lock(postId, by);
        world.modRemove(postId, by);
      } else {
        world.removeComment(comment.id, by, false);
        world.report(postId, 'Submission flagged for manual review (see comment)', by);
      }
      await send(delivery);
    },

    /** Moves the time; at each minute, runs the due cron jobs of devvit.json in each installation. Held events arrive first. */
    async advance(duration: string, options?: { only?: string[] }) {
      await release();
      await settle();
      await clock.advance(duration, options);
    },

    /** Runs one scheduler task now, in one installation (the first by default); start two to run ticks at the same time. */
    async runJob(name: string, { sub }: { sub?: string } = {}) {
      const task = devvit.scheduler.tasks[name];
      if (!task) throw new Error(`no scheduler task "${name}" in devvit.json`);
      const json = await request(installation(sub), endpointOf(task), { name, ...(typeof task !== 'string' && task.data ? { data: task.data } : {}) });
      await settle();
      return json;
    },

    /** A moderator clicks a menu item; `postId` for a post item. The response is a UiResponse. */
    async menu(label: string, { sub, postId, user }: { sub?: string; postId?: T3; user?: string } = {}) {
      const item = devvit.menu.items.find((candidate) => candidate.label === label);
      if (!item) throw new Error(`no menu item "${label}" in devvit.json`);
      const inst = installation(sub);
      const location = Array.isArray(item.location) ? item.location[0]! : item.location;
      if (location === 'post' && !postId) throw new Error(`menu item "${label}" is for a post: it needs a postId`);
      const body = { location, targetId: location === 'post' ? postId : inst.id };
      return checked(item.endpoint, await request(inst, item.endpoint, body, { user: user ?? modOf(inst), postId: location === 'post' ? postId : undefined }));
    },

    /** A moderator submits a form of devvit.json. */
    async form(name: string, values: object, { sub, user }: { sub?: string; user?: string } = {}) {
      const path = devvit.forms[name];
      if (!path) throw new Error(`no form "${name}" in devvit.json`);
      const inst = installation(sub);
      return checked(path, await request(inst, path, values, { user: user ?? modOf(inst) }));
    },

    /** A moderator edits an install setting: Devvit asks the validation route. */
    async validate(setting: string, value: unknown, { sub }: { sub?: string } = {}) {
      const def = devvit.settings.subreddit[setting];
      if (!def) throw new Error(`unknown setting "${setting}": it is not in devvit.json`);
      if (!def.validationEndpoint) throw new Error(`setting "${setting}" has no validation route in devvit.json`);
      const inst = installation(sub);
      return request(inst, def.validationEndpoint, { value, isEditing: false }, { user: modOf(inst) });
    },

    /** The calls of the app that changed Reddit for one post, in order. */
    actions: (postId: string) => world.actions.filter((action) => action.postId === postId).map(({ postId: _, ...action }) => action),

    /** Every key that the app wrote in an installation and that still exists: type, content, and `expiresAt` (epoch ms; none without a TTL). */
    keys: (sub?: string) => installation(sub).spy.keys(),

    /** The audit entries of an installation (`audit:{day}` sorted sets of JSON), oldest first. */
    async audit(sub?: string): Promise<unknown[]> {
      const keys = (await installation(sub).spy.keys()).filter(({ key }) => key.startsWith('audit:'));
      return keys.flatMap(({ text }) => (JSON.parse(text) as { member: string }[]).map(({ member }) => JSON.parse(member) as unknown));
    },

    /** The mod notifications that the app sent to an installation. */
    modmail: (sub?: string) => world.modmail.filter(({ subredditId }) => subredditId === installation(sub).id),

    /** The number of Redis calls of each request to a route, in order. `request` is a path or the name of a scheduler task. */
    redisCalls(request: string): number[] {
      const task = devvit.scheduler.tasks[request];
      if (!request.startsWith('/') && !task) throw new Error(`no scheduler task "${request}" in devvit.json`);
      const path = task ? endpointOf(task) : request;
      return requests.filter((entry) => entry.path === path).map((entry) => entry.calls);
    },

    /** The endpoints of devvit.json that the app has no POST route for: Devvit would get a 404 there. */
    unrouted(): string[] {
      // shortcut: only app.post routes count (not app.all or app.on); upgrade if the app registers routes that way.
      const served = (app.routes ?? []).filter(({ method }) => method === 'POST').map(({ path }) => new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+').replace(/\*/g, '.*')}$`));
      const endpoints = [
        ...Object.values(devvit.triggers),
        ...Object.values(devvit.scheduler.tasks).map(endpointOf),
        ...devvit.menu.items.map(({ endpoint }) => endpoint),
        ...Object.values(devvit.forms),
        ...Object.values(devvit.settings.subreddit).flatMap(({ validationEndpoint }) => (validationEndpoint ? [validationEndpoint] : [])),
      ];
      return [...new Set(endpoints)].filter((path) => !served.some((pattern) => pattern.test(path)));
    },
  };
}

export type Sim = ReturnType<typeof createSim>;
