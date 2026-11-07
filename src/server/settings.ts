// The install settings (plan 5.6): read them into a Config, and answer the validation routes.
import { settings } from '@devvit/web/server';
import type { SettingsValidationResponse } from '@devvit/web/shared';
import { NUMBER_SETTINGS, parseConfig, validateSetting, type RawSettings } from '../core/config';

/** The config, its problems, and `repostMonths` (which the config has only while repost is on; `seen:` keys need it always). */
export async function readConfig() {
  const raw = await settings.getAll<RawSettings>();
  const months = typeof raw.repostMonths === 'number' && validateSetting('repostMonths', raw.repostMonths) === undefined ? raw.repostMonths : NUMBER_SETTINGS.repostMonths.def;
  return { ...parseConfig(raw), repostMonths: months };
}

/** The answer to Devvit when a mod edits one setting. */
export function validate(name: string, value: unknown): SettingsValidationResponse {
  const error = validateSetting(name, value);
  return error === undefined ? { success: true } : { success: false, error };
}
