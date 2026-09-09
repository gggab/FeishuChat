import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, isValidTimeZone, SentrySettingsStore } from '../src/sentrySettingsStore.js';

describe('isValidTimeZone', () => {
  it('accepts real IANA timezone names, rejects garbage', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('SentrySettingsStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-settings-test-'));
    filePath = path.join(dir, 'sentrySettings.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to Asia/Riyadh when no file exists yet, matching the gateway\'s historical fixed offset', () => {
    const store = new SentrySettingsStore(filePath);
    expect(store.getTimezone()).toBe(DEFAULT_TIMEZONE);
    expect(store.getTimezone()).toBe('Asia/Riyadh');
  });

  it('setTimezone persists to disk and a fresh instance reads it back', () => {
    const store = new SentrySettingsStore(filePath);
    store.setTimezone('Asia/Shanghai');
    expect(store.getTimezone()).toBe('Asia/Shanghai');

    const reloaded = new SentrySettingsStore(filePath);
    expect(reloaded.getTimezone()).toBe('Asia/Shanghai');
  });

  it('setTimezone throws on an invalid IANA name and leaves the previous value in place', () => {
    const store = new SentrySettingsStore(filePath);
    store.setTimezone('Asia/Shanghai');
    expect(() => store.setTimezone('Not/AZone')).toThrow();
    expect(store.getTimezone()).toBe('Asia/Shanghai');
  });

  it('falls back to the default if the settings file on disk is corrupted or has an invalid timezone', () => {
    fs.writeFileSync(filePath, JSON.stringify({ settings: { timezone: 'Not/AZone' } }));
    expect(new SentrySettingsStore(filePath).getTimezone()).toBe(DEFAULT_TIMEZONE);

    fs.writeFileSync(filePath, '{not valid json');
    expect(() => new SentrySettingsStore(filePath)).toThrow();
  });
});
