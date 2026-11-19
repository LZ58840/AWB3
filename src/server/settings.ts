// The install settings (plan 5.6): read them into a Config, and answer the validation routes.
import { settings } from '@devvit/web/server';
import type { SettingsValidationResponse } from '@devvit/web/shared';
import { parseConfig, validateSetting, type RawSettings } from '../core/config';

export async function readConfig() {
  return parseConfig(await settings.getAll<RawSettings>());
}

/** The answer to Devvit when a mod edits one setting. */
export function validate(name: string, value: unknown): SettingsValidationResponse {
  const error = validateSetting(name, value);
  return error === undefined ? { success: true } : { success: false, error };
}
