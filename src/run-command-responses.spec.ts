import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The four shapes a generated command can get back.
 *
 * Five operations in the generated set do not answer in JSON — `synthesize`
 * (binary audio), `transcribe`, `complete` and the SMS stream (server-sent
 * events), and the agent analysis export (CSV). Every one of them used to throw
 * `SyntaxError` on a successful response, because the client parsed any
 * non-empty body as JSON before looking at what it was.
 *
 * `apiRequest` is stubbed rather than `fetch`, so these exercise the dispatch
 * itself. The CSV path is additionally verified against the live server; the
 * binary and SSE paths cannot be, because reaching them needs TTS/STT provider
 * credentials that a local stack does not have.
 */
const apiRequest = vi.fn();
vi.mock('./api-client.js', async () => {
  const actual = await vi.importActual<typeof import('./api-client.js')>('./api-client.js');
  return { ...actual, apiRequest: (...args: unknown[]) => apiRequest(...args) };
});

const { runGeneratedCommand } = await import('./run-command.js');
const { COMMANDS } = await import('./generated/commands.js');

const commandNamed = (name: string) => {
  const found = COMMANDS.find((c) => c.name === name);
  if (!found) throw new Error(`no generated command ${name}`);
  return found;
};

const respondWith = (body: string | Uint8Array | ReadableStream | null, type: string) => {
  apiRequest.mockResolvedValueOnce(
    new Response(body, { status: 200, headers: { 'content-type': type } }),
  );
};

beforeEach(() => {
  apiRequest.mockReset();
});

describe('non-JSON responses', () => {
  it('prints CSV as it came rather than parsing it', async () => {
    respondWith('"call_id","status"\n"abc","ended"\n', 'text/csv');
    const result = await runGeneratedCommand(commandNamed('export-agent-analysis-csv'), [
      'agent_1',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('"call_id","status"');
  });

  it('refuses to print binary to the terminal, and says how to get it', async () => {
    respondWith(new Uint8Array([0x52, 0x49, 0x46, 0x46]), 'application/octet-stream');
    const failure = runGeneratedCommand(commandNamed('synthesize'), [
      '--data',
      '{"intent":{"language":"en"},"text":"hi"}',
    ]);
    // The what is the message, the how is the hint — `index.ts` prints both.
    await expect(failure).rejects.toThrow(/returns application\/octet-stream/);
    await expect(failure).rejects.toMatchObject({ hint: expect.stringContaining('--output') });
  });

  it('writes binary to the file it was given', async () => {
    const target = join(tmpdir(), `speko-cli-test-${Date.now()}.bin`);
    respondWith(new Uint8Array([0x52, 0x49, 0x46, 0x46]), 'application/octet-stream');
    const result = await runGeneratedCommand(commandNamed('synthesize'), [
      '--data',
      '{"intent":{"language":"en"},"text":"hi"}',
      '--output',
      target,
    ]);
    expect(result.exitCode).toBe(0);
    // The bytes must survive intact — routing them through a string would
    // corrupt any byte that is not valid UTF-8.
    expect([...readFileSync(target)]).toEqual([0x52, 0x49, 0x46, 0x46]);
    expect(result.lines.join('\n')).toContain(target);
    rmSync(target, { force: true });
  });

  it('streams server-sent events instead of waiting for the body to end', async () => {
    // `sms stream-sms-events` never ends on its own. Buffering to completion
    // would hang forever on a command that is working perfectly.
    const chunks = ['event: a\ndata: 1\n\n', 'event: b\ndata: 2\n\n'];
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    respondWith(stream, 'text/event-stream');

    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        return true;
      });

    const result = await runGeneratedCommand(commandNamed('complete'), [
      '--data',
      '{"intent":{"language":"en"},"messages":[]}',
    ]);
    spy.mockRestore();

    expect(result.exitCode).toBe(0);
    expect(written.join('')).toContain('data: 1');
    expect(written.join('')).toContain('data: 2');
  });

  it('still parses a JSON response', async () => {
    respondWith('{"agents":[]}', 'application/json');
    const result = await runGeneratedCommand(commandNamed('list-agents'), []);
    expect(result.data).toEqual({ agents: [] });
  });
});
