// The entry of the bundle that Devvit runs (devvit.json: server.entry).
import { getServerPort } from '@devvit/web/server';
import { app } from './app';
import { serve } from './serve';

serve(app, getServerPort());
