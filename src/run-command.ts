import { readFileSync, writeFileSync } from 'node:fs';
import { ApiError, apiRequest, isJsonResponse } from './api-client.js';
import { EXIT, type ExitCode } from './constants.js';
import { COMMANDS, type GeneratedCommand } from './generated/commands.js';

/** Where the Agents API spec actually lives. See the note in `describeCommand`. */
const SPEC_URL = 'https://docs.speko.ai/openapi.json';

import { humanGateFor } from './human-gated.js';

/**
 * Runs any operation in the generated command table.
 *
 * One executor rather than 85 hand-written commands: the table already carries
 * the method, the path template, which placeholders it has, which query
 * parameters exist and whether a body is required, so the only thing left is to
 * assemble a request from argv. Adding an endpoint to the API becomes a
 * regeneration rather than a code change.
 *
 * Shape:  speko-cli <group> <command> [path args…] [--query value] [--data JSON]
 *
 * Path parameters are POSITIONAL, in the order they appear in the URL. Named
 * flags for them would collide with query parameters of the same name — `id`
 * appears as both across this API — and positional order is the one thing the
 * path template states unambiguously.
 */

/**
 * Pulls a list out of a response using the key the SPEC declares for that path.
 *
 * Replaces guessing. The API wraps lists four different ways and documents all
 * four correctly, so a client that tries `data`, then `entries`, then `voices`
 * is doing avoidable work — and doing it wrongly the moment an endpoint uses a
 * word the guesser has not heard of. That failure is silent: an empty list
 * looks exactly like a genuinely empty result, which is how `doctor` came to
 * report an unreachable voice as fine.
 *
 * `null` from the table means the operation returns a bare array, so the
 * payload is the list.
 */
export function unwrapList<T>(path: string, method: string, payload: unknown): T[] {
  const command = COMMANDS.find((c) => c.path === path && c.method === method);
  if (!command) {
    // An unknown path is a programming error, not runtime data — say so rather
    // than falling back to a guess and hiding it.
    throw new Error(`No generated command for ${method} ${path}; cannot resolve its list key.`);
  }

  if (command.responseListKey === null) {
    return Array.isArray(payload) ? (payload as T[]) : [];
  }
  if (!payload || typeof payload !== 'object') return [];
  const value = (payload as Record<string, unknown>)[command.responseListKey];
  return Array.isArray(value) ? (value as T[]) : [];
}

export interface CommandLookup {
  readonly command: GeneratedCommand | null;
  /** Populated when the group exists but the command does not. */
  readonly groupCommands: readonly GeneratedCommand[];
}

export function findCommand(group: string, name: string | undefined): CommandLookup {
  const groupCommands = COMMANDS.filter((c) => c.group === group);
  if (!name) return { command: null, groupCommands };
  const command =
    groupCommands.find((c) => c.name === name) ??
    groupCommands.find((c) => c.aliases.includes(name)) ??
    null;
  return { command, groupCommands };
}

/** `--limit 10`, `--limit=10`, and `--flag` (as `true`) all parse. */
export function parseFlags(args: readonly string[]): {
  flags: Record<string, string>;
  positionals: string[];
} {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = 'true';
    }
  }

  return { flags, positionals };
}

export function describeCommand(command: GeneratedCommand): string[] {
  const lines = [
    `${command.summary || command.operationId}`,
    '',
    `  speko-cli ${command.group} ${command.name}${command.pathParams
      .map((p) => ` <${p.name}>`)
      .join('')}${command.body === 'none' ? '' : ' --data JSON'}`,
    '',
    `  ${command.method} /v1${command.path}`,
  ];

  if (command.aliases.length > 0) {
    lines.push('', `  Alias: speko-cli ${command.group} ${command.aliases.join(', ')}`);
  }
  if (command.pathParams.length > 0) {
    lines.push('', '  Arguments');
    for (const p of command.pathParams) {
      lines.push(`    <${p.name}>${p.description ? `  ${p.description}` : ''}`);
    }
  }
  if (command.queryParams.length > 0) {
    lines.push('', '  Options');
    for (const p of command.queryParams) {
      const req = p.required ? ' (required)' : '';
      lines.push(`    --${p.name}${req}${p.description ? `  ${p.description}` : ''}`);
    }
  }
  if (command.body !== 'none') {
    lines.push(
      '',
      `  Request body (${command.body})${command.bodySchema ? ` — ${command.bodySchema}` : ''}`,
    );

    /**
     * The fields, not just "pass JSON".
     *
     * Without these, help said what to do and never what to say: a caller was
     * told to supply a body and had to go and read openapi.json to learn which
     * keys it takes. For an agent that means a second fetch and a guess; the
     * one thing help exists to prevent.
     *
     * Required fields sort first so a minimal body can be read straight off,
     * and `*` marks them so the two groups stay distinguishable when the list
     * is long.
     */
    if (command.bodyFields.length > 0) {
      const width = Math.max(
        ...command.bodyFields.map((f) => f.name.length + (f.required ? 1 : 0)),
      );
      for (const field of command.bodyFields) {
        const name = `${field.name}${field.required ? '*' : ''}`.padEnd(width);
        lines.push(
          `    ${name}  ${field.type}${field.description ? `  ${field.description}` : ''}`,
        );
      }
      lines.push('', '    * required');
    }

    lines.push(
      '',
      '    --data JSON     inline JSON',
      '    --file PATH     read JSON from a file',
      '    (or pipe JSON on stdin)',
    );

    /**
     * Nested objects are named, not expanded, so point at where the full
     * definition lives rather than reprinting the spec.
     *
     * `docs.speko.ai`, NOT `speko.ai`. The first draft used the latter, which
     * is a proxy to the Router contract — five paths, no agent schemas — so the
     * link pointed at a document that could not contain the anchor it named, on
     * all 36 commands with a body. `docs.speko.dev` also works but answers 308,
     * and a link that redirects is a link an agent has to follow twice.
     */
    if (command.bodySchema) {
      lines.push('', `  Full schema: ${SPEC_URL}#/components/schemas/${command.bodySchema}`);
    }
  }
  return lines;
}

export function groupHelp(group: string, commands: readonly GeneratedCommand[]): string[] {
  const width = Math.max(...commands.map((c) => c.name.length));
  return [
    `speko-cli ${group} — ${commands.length} operations`,
    '',
    ...commands.map((c) => {
      const alias = c.aliases.length > 0 ? ` (${c.aliases.join(', ')})` : '';
      return `  ${c.name.padEnd(width)}  ${c.summary}${alias}`;
    }),
    '',
    `Run \`speko-cli ${group} <command> --help\` for arguments.`,
  ];
}

function readBody(flags: Record<string, string>): string | undefined {
  if (flags['data'] !== undefined) return flags['data'];
  if (flags['file'] !== undefined) return readFileSync(flags['file'], 'utf8');
  // Only read stdin when something is actually piped. Checking this matters:
  // on a TTY a blocking read would hang with no prompt and no explanation.
  if (!process.stdin.isTTY) {
    const piped = readFileSync(0, 'utf8');
    if (piped.trim().length > 0) return piped;
  }
  return undefined;
}

export interface RunResult {
  readonly exitCode: ExitCode;
  readonly lines: readonly string[];
  readonly data?: unknown;
}

export async function runGeneratedCommand(
  command: GeneratedCommand,
  args: readonly string[],
): Promise<RunResult> {
  const { flags, positionals } = parseFlags(args);

  if (flags['help'] !== undefined) {
    return { exitCode: EXIT.ok, lines: describeCommand(command) };
  }

  if (positionals.length < command.pathParams.length) {
    const expected = command.pathParams.map((p) => `<${p.name}>`).join(' ');
    return {
      exitCode: EXIT.usage,
      lines: [
        `Missing argument. Expected: speko-cli ${command.group} ${command.name} ${expected}`,
        `Run \`speko-cli ${command.group} ${command.name} --help\` for details.`,
      ],
    };
  }

  let path = command.path;
  command.pathParams.forEach((param, index) => {
    path = path.replace(`{${param.name}}`, encodeURIComponent(positionals[index] as string));
  });

  const query = new URLSearchParams();
  for (const param of command.queryParams) {
    const value = flags[param.name];
    if (value !== undefined) query.set(param.name, value);
    else if (param.required) {
      return {
        exitCode: EXIT.usage,
        lines: [`Missing required option --${param.name}.`],
      };
    }
  }
  const queryString = query.toString();
  const url = queryString ? `${path}?${queryString}` : path;

  const rawBody = command.body === 'none' ? undefined : readBody(flags);
  if (command.body === 'required' && rawBody === undefined) {
    return {
      exitCode: EXIT.usage,
      lines: [
        `${command.method} ${command.path} needs a request body.`,
        'Pass --data JSON, --file PATH, or pipe JSON on stdin.',
      ],
    };
  }
  if (rawBody !== undefined) {
    try {
      JSON.parse(rawBody);
    } catch {
      // Sending it anyway would surface as a server-side validation error that
      // says nothing about the real problem being local malformed JSON.
      return { exitCode: EXIT.usage, lines: ['The request body is not valid JSON.'] };
    }
  }

  /**
   * Refused before the request, not after. A gate that let the call through and
   * complained afterwards would have already written the thing it objects to.
   */
  const refusal = humanGateFor(command.operationId, rawBody);
  if (refusal) {
    return {
      exitCode: EXIT.usage,
      lines: [
        `${command.group} ${command.name} is not something the CLI will do for you.`,
        '',
        `  ${refusal.reason}`,
        '',
        `  Do it here: ${refusal.url}`,
      ],
    };
  }

  const response = await apiRequest(url, {
    method: command.method,
    ...(rawBody === undefined ? {} : { body: rawBody }),
  });

  const contentType = response.headers.get('content-type') ?? '';

  /**
   * Binary goes to a file, never to the terminal.
   *
   * `voice synthesize` answers with audio. Printing those bytes would corrupt
   * them on the way through a string and fill the terminal with noise, so this
   * asks for a destination instead of guessing one. A caller who wants the raw
   * stream can still have it: `--output -` writes to stdout, which is what a
   * pipe into `ffplay` needs.
   */
  if (contentType.includes('application/octet-stream') || contentType.startsWith('audio/')) {
    const target = flags['output'];
    if (!target) {
      throw new ApiError(
        response.status,
        `${command.group} ${command.name} returns ${contentType || 'binary data'}.`,
        'Pass --output <file> to save it, or --output - to write it to stdout.',
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (target === '-') {
      process.stdout.write(bytes);
      return { exitCode: EXIT.ok, lines: [], data: null };
    }
    writeFileSync(target, bytes);
    return {
      exitCode: EXIT.ok,
      lines: [`Wrote ${bytes.byteLength} bytes to ${target}.`],
      data: { output: target, bytes: bytes.byteLength, contentType },
    };
  }

  /**
   * Server-sent events are printed as they arrive.
   *
   * Buffering to the end is not an option: `sms stream-sms-events` does not end
   * on its own, so waiting for the body would hang forever on a command that is
   * working perfectly. Chunks go out unparsed — the wire format is the honest
   * thing to show, and re-shaping it here would only invent a schema the server
   * never promised.
   */
  if (contentType.includes('text/event-stream')) {
    const body = response.body;
    if (!body) return { exitCode: EXIT.ok, lines: [], data: null };
    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      process.stdout.write(decoder.decode(value, { stream: true }));
    }
    process.stdout.write(decoder.decode());
    return { exitCode: EXIT.ok, lines: [], data: null };
  }

  // Anything else textual — CSV from the analysis export, most obviously — is
  // printed as it came. It is already the format the caller asked for.
  if (!isJsonResponse(response)) {
    const text = await response.text();
    return { exitCode: EXIT.ok, lines: text.length > 0 ? [text.trimEnd()] : [], data: text };
  }

  const text = await response.text();
  const data: unknown = text.length > 0 ? JSON.parse(text) : null;

  return {
    exitCode: EXIT.ok,
    /**
     * Always prints something. Generated commands return data, not prose, so
     * the readable form and the machine form are the same thing — but skipping
     * output for a null body meant `sms get-sms-settings` wrote zero bytes to
     * both streams and exited 0, which is indistinguishable from a crash.
     *
     * `null` is printed as `null` rather than translated into a 404: the server
     * answered 200, and inventing a different status would be the CLI lying
     * about what it was told.
     */
    lines: [JSON.stringify(data ?? null, null, 2)],
    data,
  };
}
