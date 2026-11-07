// The Hono app: every endpoint of devvit.json. index.ts serves it; the tests call it directly.
import type { SettingsValidationRequest } from '@devvit/web/shared';
import { Hono } from 'hono';
import { health, sweep, tick } from './jobs';
import { explain, shadowReport, shadowReportMenu, status } from './menu';
import { validate } from './settings';
import { onPostFlairUpdate, onPostSubmit } from './triggers';

export const app = new Hono();

// A job or a trigger answers {} when it has nothing to say. A job may come with no body. 3.0 serves what devvit.json lists, and nothing else.
type Handler = (body: never) => Promise<unknown>;
const route = (path: string, handler: Handler) =>
  app.post(path, async (c) => c.json(((await handler((await c.req.json().catch(() => undefined)) as never)) ?? {}) as object));

route('/internal/triggers/post-submit', onPostSubmit);
route('/internal/triggers/post-flair-update', onPostFlairUpdate);

route('/internal/cron/tick', tick);
route('/internal/cron/sweep', sweep);
route('/internal/cron/health', health);

route('/internal/menu/status', status);
route('/internal/menu/explain', explain);
route('/internal/menu/shadow-report', shadowReportMenu);
route('/internal/forms/info', async () => undefined);
route('/internal/forms/shadow-report', shadowReport);

app.post('/internal/settings/validate/:name', async (c) =>
  c.json(validate(c.req.param('name'), (await c.req.json<SettingsValidationRequest<unknown>>()).value)),
);

app.onError((error, c) => {
  console.error(`route error; ${error.stack}`);
  return c.json({ error: error.message }, 500);
});
