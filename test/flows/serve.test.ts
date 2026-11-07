// index.ts hands the Hono app to Devvit's createServer. The simulator calls app.request(), so this is the one test of the
// real entry: a Node HTTP request goes to the fetch-style app, with the Devvit context of its headers, and the answer comes back.
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { context } from '@devvit/web/server';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import devvit from '../../devvit.json';
import { serve } from '../../src/server/serve';

const DEVVIT_HEADERS = {
  'content-type': 'application/json',
  'devvit-app': devvit.name,
  'devvit-version': '0.0.0-test',
  'devvit-app-user': `t2_${devvit.name}`,
  'devvit-subreddit': 't5_animewallpaper',
  'devvit-subreddit-name': 'Animewallpaper',
  'devvit-user': 't2_mod1',
  'devvit-user-name': 'mod1',
};

test('a request of Devvit reaches the app with its body and its context, and the JSON answer comes back', async () => {
  const app = new Hono();
  app.post('/internal/echo', async (c) => c.json({ body: await c.req.json(), sub: context.subredditName, user: context.username }, 201));
  const server = serve(app, 0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: DEVVIT_HEADERS, body: JSON.stringify(body) });
  try {
    const ok = await send('/internal/echo', { a: [1, 2] });
    expect(ok.status).toBe(201);
    expect(ok.headers.get('content-type')).toContain('application/json');
    expect(await ok.json()).toEqual({ body: { a: [1, 2] }, sub: 'Animewallpaper', user: 'mod1' });
    const missing = await send('/internal/nothing', {});
    expect(missing.status).toBe(404);
  } finally {
    server.close();
  }
});

test('an app whose fetch throws gives a 500 with a JSON body and a line in the log, and the server stays up', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const server = serve({ fetch: () => { throw new Error('boom'); } }, 0);
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/anything`;
  try {
    for (let i = 0; i < 2; i++) {
      const res = await fetch(url, { method: 'POST', headers: DEVVIT_HEADERS, body: '{}' });
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ error: 'Error: boom' });
    }
    expect(String(log.mock.calls[0]?.[0])).toContain('server error; Error: boom');
  } finally {
    server.close();
  }
});
