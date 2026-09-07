import { describe, expect, it } from 'vitest';
import { ApiError, apiFetch, NotSignedInError } from './api-client.js';
import { type CliDevice, formatDeviceRows, relativeTime } from './auth-commands.js';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

const device = (over: Partial<CliDevice> = {}): CliDevice => ({
  id: 'BSKOrO09sPAeMufO1f2pzaFygIhd87zY',
  label: 'MacBook-Pro-3.local (darwin)',
  cli_version: '0.1.0',
  ip_address: '127.0.0.1',
  signed_in_at: '2026-09-03T11:00:00.000Z',
  last_seen_at: '2026-09-03T11:59:30.000Z',
  expires_at: '2026-09-10T11:00:00.000Z',
  current: true,
  ...over,
});

describe('relativeTime', () => {
  it('reads as a duration, not a timestamp', () => {
    expect(relativeTime('2026-09-03T11:59:30.000Z', NOW)).toBe('just now');
    expect(relativeTime('2026-09-03T11:30:00.000Z', NOW)).toBe('30m ago');
    expect(relativeTime('2026-09-03T09:00:00.000Z', NOW)).toBe('3h ago');
    expect(relativeTime('2026-08-31T12:00:00.000Z', NOW)).toBe('3d ago');
  });

  it('falls back to the raw value it cannot parse', () => {
    expect(relativeTime('not a date', NOW)).toBe('not a date');
  });
});

describe('formatDeviceRows', () => {
  it('aligns the id column, because the id is what gets copied into revoke', () => {
    const rows = formatDeviceRows(
      [device(), device({ id: 'short', label: 'moria (linux)', current: false })],
      NOW,
    );
    const idWidth = 'BSKOrO09sPAeMufO1f2pzaFygIhd87zY'.length;

    expect(rows[0]?.startsWith('ID'.padEnd(idWidth))).toBe(true);
    expect(rows[1]?.startsWith('BSKOrO09sPAeMufO1f2pzaFygIhd87zY  ')).toBe(true);
    expect(rows[2]?.startsWith(`short${' '.repeat(idWidth - 5)}  `)).toBe(true);
  });

  it('marks the calling device so revoking it is not a surprise', () => {
    const rows = formatDeviceRows([device(), device({ id: 'other', current: false })], NOW);
    expect(rows[1]).toContain('(this device)');
    expect(rows[2]).not.toContain('(this device)');
  });
});

describe('apiFetch', () => {
  it('refuses to call anything when no credential is stored', async () => {
    // XDG_CONFIG_HOME points at a directory with no credentials file, so this
    // exercises the real reader rather than a stub.
    process.env['XDG_CONFIG_HOME'] = '/nonexistent-speko-cli-test-home';
    await expect(apiFetch('/cli-devices')).rejects.toBeInstanceOf(NotSignedInError);
  });
});

describe('ApiError', () => {
  it('carries the status so the caller can pick an exit code', () => {
    const error = new ApiError(403, 'Nope', 'Do it in the console.');
    expect(error.status).toBe(403);
    expect(error.hint).toBe('Do it in the console.');
  });
});
