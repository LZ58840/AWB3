// The alerts of the app to the mods (plan 5.4 health): a modmail notification, at most one for each reason in 6 hours.
import { context, reddit } from '@devvit/web/server';
import { readHealth, writeHealth } from './store';

const ALERT_EVERY_MS = 6 * 3_600_000;

/** The text of an error for the audit, the alerts and `health.lastError`: no URL, short. */
export const reasonOf = (error: unknown): string => String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);

/**
 * A modmail notification to the mods, at most one for each reason in 6 hours. A modmail that fails does not stop the caller (the health
 * job, the tick): the error goes to the app log, `lastAlertAt` stays as it was, and the next call tries again.
 */
export async function alert(reason: string, text: string): Promise<void> {
  try {
    if (Date.now() - Number((await readHealth(`lastAlertAt:${reason}`)) ?? 0) < ALERT_EVERY_MS) return;
    await reddit.modMail.createModNotification({ subject: `AWB: ${reason}`, bodyMarkdown: text, subredditId: context.subredditId });
    await writeHealth({ [`lastAlertAt:${reason}`]: String(Date.now()) });
  } catch (error) {
    console.error(JSON.stringify({ evt: 'error', sub: context.subredditName, reason: `alert ${reason} failed`, error: reasonOf(error) }));
  }
}
