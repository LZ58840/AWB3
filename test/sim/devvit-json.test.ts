// devvit.json is the contract between Devvit and the app: the simulator reads its routes, crons, menus and settings.
import { parseAppConfigJson } from '@devvit/shared-types/schemas/config-file.v1.js';
import { expect, test, vi } from 'vitest';
import devvit from '../../devvit.json';

const settings = devvit.settings.subreddit as Record<string, { type: string; validationEndpoint?: string }>;

test('the Devvit CLI schema and cross-field checks accept devvit.json', () => {
  const warn = vi.spyOn(console, 'warn');
  const config = parseAppConfigJson(devvit as never, false);
  expect(warn).not.toHaveBeenCalled(); // an unknown $schema only warns
  expect(config.permissions.redis).toBe(true);
});

test('the validator has teeth: a route outside /internal is rejected', () => {
  expect(() => parseAppConfigJson({ ...devvit, triggers: { onPostSubmit: '/api/oops' } } as never, false)).toThrow(/pattern/);
});

test('3.0 permissions: Reddit with moderator scope and Redis, no fetch', () => {
  const { permissions } = parseAppConfigJson(devvit as never, false);
  expect(permissions.reddit).toMatchObject({ enable: true, scope: 'moderator' });
  expect(permissions.http).toEqual({ enable: false, domains: [] });
  expect(permissions.media).toBe(false);
});

test('3.0 ships only the triggers and cron jobs that do work: post submit, flair update, tick, sweep and health', () => {
  expect(devvit.triggers).toEqual({
    onPostSubmit: '/internal/triggers/post-submit',
    onPostFlairUpdate: '/internal/triggers/post-flair-update',
  });
  expect(devvit.scheduler.tasks).toEqual({
    tick: { endpoint: '/internal/cron/tick', cron: '* * * * *' },
    sweep: { endpoint: '/internal/cron/sweep', cron: '*/5 * * * *' },
    health: { endpoint: '/internal/cron/health', cron: '*/15 * * * *' },
  });
});

test('sourceIgnores keep the tools, the private fixtures and the spike (its log has real names) out of the review archive', () => {
  expect(devvit.sourceIgnores).toEqual(['tools/**', 'test/fixtures/private/**', 'spikes/**']);
});

test('three moderator menu items; each form name that a menu can show has a submit route', () => {
  expect(devvit.menu.items.map(({ label, location, forUserType }) => [label, location, forUserType])).toEqual([
    ['AWB: status', 'subreddit', 'moderator'],
    ['AWB: explain', 'post', 'moderator'],
    ['AWB: shadow report', 'subreddit', 'moderator'],
  ]);
  expect(Object.keys(devvit.forms).sort()).toEqual(['info', 'shadowReport']);
});

test('install settings of plan section 5.6 that 3.0 uses, in display order; repostMonths stays as the history length that `seen:` needs', () => {
  expect(Object.keys(settings)).toEqual([
    'mode', 'exceptAuthors', 'flairRules',
    'resolutionMismatch',
    'resolutionBad', 'minHorizontal', 'minVertical', 'minSquare',
    'aspectRatio', 'aspectHorizontal', 'aspectVertical',
    'rateLimit', 'rateLimitHours', 'rateLimitPosts', 'rateLimitCountDeleted',
    'sourceComment', 'sourceHours',
    'repostMonths',
  ]);
  expect((devvit.settings.subreddit.repostMonths as { label: string }).label).toMatch(/history/i);
});

test('free-form settings have a validation route named after the setting; toggles and selects have none', () => {
  for (const [name, setting] of Object.entries(settings)) {
    const free = !['boolean', 'select'].includes(setting.type);
    expect(setting.validationEndpoint, name).toBe(free ? `/internal/settings/validate/${name}` : undefined);
  }
});

test('plan defaults: everything off, rate limit 24 h and 4 posts, source 1 h, a history of 6 months', () => {
  const defaults = Object.fromEntries(Object.entries(devvit.settings.subreddit).map(([name, s]) => [name, (s as { defaultValue?: unknown }).defaultValue]));
  expect(defaults).toMatchObject({
    mode: 'off', exceptAuthors: '', flairRules: '', resolutionMismatch: false, resolutionBad: false, aspectRatio: false,
    rateLimit: false, rateLimitHours: 24, rateLimitPosts: 4, rateLimitCountDeleted: false, sourceComment: false, sourceHours: 1, repostMonths: 6,
  });
});
