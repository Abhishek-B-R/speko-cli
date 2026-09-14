import { apiFetch } from './api-client.js';

/**
 * `speko-cli auth list` and `speko-cli auth revoke` — the terminal's view of the same
 * data the console's CLI devices page shows.
 *
 * Both read the same endpoints deliberately. A user who revokes a device in one
 * place and then looks in the other must not see two different answers, and the
 * quickest way to guarantee that is for neither surface to own its own copy.
 */

export interface CliDevice {
  readonly id: string;
  readonly label: string;
  readonly cli_version: string | null;
  readonly ip_address: string | null;
  readonly signed_in_at: string;
  readonly last_seen_at: string;
  readonly expires_at: string;
  readonly current: boolean;
}

export function listDevices(): Promise<{ devices: CliDevice[] }> {
  return apiFetch<{ devices: CliDevice[] }>('/cli-devices');
}

export function revokeDevice(
  id: string,
): Promise<{ revoked: true; id: string; was_current: boolean }> {
  return apiFetch(`/cli-devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function revokeAllDevices(): Promise<{ revoked: true; count: number }> {
  return apiFetch('/cli-devices', { method: 'DELETE' });
}

/** Short, stable relative time. Avoids a dependency for one format. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Fixed-width rows, because the id is what the user has to copy into
 * `speko-cli auth revoke` and a ragged column makes that a transcription exercise.
 */
export function formatDeviceRows(devices: readonly CliDevice[], now?: number): string[] {
  const idWidth = Math.max(2, ...devices.map((d) => d.id.length));
  const labelWidth = Math.max(6, ...devices.map((d) => d.label.length));
  return [
    `${'ID'.padEnd(idWidth)}  ${'DEVICE'.padEnd(labelWidth)}  LAST USED`,
    ...devices.map((device) => {
      const marker = device.current ? '  (this device)' : '';
      return `${device.id.padEnd(idWidth)}  ${device.label.padEnd(labelWidth)}  ${relativeTime(
        device.last_seen_at,
        now,
      )}${marker}`;
    }),
  ];
}
