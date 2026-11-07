// The entry of the bundle that Devvit runs (devvit.json: server.entry). Devvit's createServer gives a Node HTTP server; each request
// goes to the fetch-style Hono app, as in src/server/serve.ts of AWB3.
import { createServer, getServerPort } from '@devvit/web/server';
import { app } from './app';

createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, [value].flat().join(', '));
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
    const response = await app.fetch(new Request(new URL(req.url ?? '/', 'http://localhost'), { method: req.method, headers, body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(`server error; ${(error as Error).stack}`);
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
  }
}).listen(getServerPort());
