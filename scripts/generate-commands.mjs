#!/usr/bin/env node
/**
 * Generates the CLI's command table from the published OpenAPI document.
 *
 * WHY GENERATED AND COMMITTED, RATHER THAN READ AT RUNTIME. Three things
 * describe the same API — this CLI (TypeScript), the MCP server (Python), and
 * the docs — and hand-maintaining all three guarantees they drift, which
 * surfaces as an agent confidently calling a parameter that no longer exists.
 * Generating from one source removes that. Committing the OUTPUT keeps the
 * published package dependency-free and the diff reviewable: a spec change that
 * renames an operation shows up as a line in a pull request instead of a
 * behaviour change nobody saw.
 *
 * `--check` re-generates in memory and exits non-zero if the committed file
 * differs, so a spec edit that nobody regenerated fails CI instead of shipping
 * a CLI that disagrees with the server.
 *
 * NAMING. The canonical subcommand is the operationId, kebab-cased —
 * `listAgents` becomes `speko-cli agents list-agents`. Predictable beats pretty
 * here: an agent reading `--help` uses exactly what is printed, and any rule
 * clever enough to produce a nicer name is a rule that produces surprises on
 * the operations it was not designed for. The conventional REST five (list,
 * get, create, update, delete) are added as ALIASES where the method and path
 * shape make them unambiguous within a group, so humans get the short form
 * without the generated names becoming unpredictable.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(here, '../../../apps/docs/content/openapi.json');
const OUT_PATH = join(here, '../src/generated/commands.ts');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const kebab = (value) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');

/** `/v1/agents/{id}` → `/agents/{id}`; apiFetch supplies the version prefix. */
const stripVersion = (path) => path.replace(/^\/v1/, '');

/** True when the path's last segment is a parameter, i.e. it addresses one item. */
const addressesItem = (path) => /\{[^}]+\}$/.test(path);

/** How deep a path sits, for deciding which claimant owns a group's alias. */
const pathDepth = (path) => path.split('/').filter(Boolean).length;

function restAlias(method, path) {
  const item = addressesItem(path);
  if (method === 'get') return item ? 'get' : 'list';
  if (method === 'post') return item ? null : 'create';
  if (method === 'patch' || method === 'put') return item ? 'update' : null;
  if (method === 'delete') return item ? 'delete' : null;
  return null;
}

function bodyRequirement(op) {
  const body = op.requestBody;
  if (!body) return 'none';
  return body.required ? 'required' : 'optional';
}

/** `#/components/schemas/Foo` → `Foo`. */
const refName = (ref) => (typeof ref === 'string' ? ref.split('/').pop() : undefined);

/**
 * A schema node's type, as one printable word.
 *
 * `$ref` becomes the referenced schema's NAME rather than `object`, because
 * "intent: object" tells a caller nothing they can act on while
 * "intent: AgentIntent" is a term they can look up in the spec.
 */
function typeLabel(node, spec) {
  if (!node || typeof node !== 'object') return 'unknown';
  if (node.$ref) return refName(node.$ref) ?? 'object';
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const branches = (node.anyOf ?? node.oneOf)
      .map((b) => typeLabel(b, spec))
      .filter((t) => t !== 'null');
    return [...new Set(branches)].join('|') || 'unknown';
  }
  if (node.type === 'array') return `${typeLabel(node.items ?? {}, spec)}[]`;
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join('|');
  // OpenAPI 3.1 allows `type` to be an ARRAY — `type: ['string', 'null']` is
  // how this spec expresses a nullable field. Returning it verbatim put a
  // `string[]` where the generated interface promises a `string`, which the
  // typecheck caught.
  if (Array.isArray(node.type)) {
    const named = node.type.filter((t) => t !== 'null');
    return named.join('|') || 'null';
  }
  return node.type ?? 'unknown';
}

/**
 * Top-level fields of a request body, so `--help` can say WHAT json to pass.
 *
 * Only one level deep, deliberately. The whole point is a caller being able to
 * construct a first request from the terminal; a recursive dump of every nested
 * schema is a spec printout, which is what openapi.json already is and is
 * linked for. Nested objects are named by their schema so the reader knows what
 * to look up.
 */
function bodyFields(op, spec) {
  const content = op.requestBody?.content?.['application/json'];
  if (!content?.schema) return { fields: [], schemaName: undefined };

  const schemaName = refName(content.schema.$ref);
  const schema = schemaName ? (spec.components?.schemas?.[schemaName] ?? {}) : content.schema;
  const required = new Set(schema.required ?? []);
  const properties = schema.properties ?? {};

  const fields = Object.entries(properties).map(([name, node]) => ({
    name,
    type: typeLabel(node, spec),
    required: required.has(name),
    // One line. A paragraph per field turns help into a document nobody reads.
    description: (node.description ?? '').split('\n')[0].trim().slice(0, 110),
  }));

  // Required first, then alphabetical: a caller writing a minimal body needs
  // exactly the required set and should not have to scan for it.
  fields.sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
  return { fields, schemaName };
}

/**
 * The property that holds the list, for an operation that returns one.
 *
 * The API wraps lists inconsistently — `/agents` is a bare array, `/voices`
 * uses `{ voices }`, `/webhooks` uses `{ data }`, `/sessions` uses
 * `{ entries }` — but the SPEC DECLARES ALL OF IT CORRECTLY. Every one of those
 * shapes was checked against the live API and matched.
 *
 * So a client has no reason to guess, and the first version of the CLI's list
 * handling guessed anyway: it tried `data`, `entries`, `voices`, … in order and
 * took whatever hit first. That works until an endpoint uses a word not in the
 * list, and it failed silently when it did — the voice check in `doctor` found
 * no vendors and reported an unreachable voice as fine.
 *
 * Reading it from the spec removes the guess. `null` means the operation
 * returns a bare array or is not a list at all.
 */
function responseListKey(op, spec, path) {
  const content = op.responses?.['200']?.content?.['application/json'];
  if (!content?.schema) return null;

  let schema = content.schema;
  if (schema.$ref) schema = spec.components?.schemas?.[refName(schema.$ref)] ?? {};
  if (schema.type === 'array') return null;
  if (schema.type !== 'object' || !schema.properties) return null;

  const arrays = Object.entries(schema.properties)
    .filter(([, node]) => {
      const resolved = node.$ref ? (spec.components?.schemas?.[refName(node.$ref)] ?? {}) : node;
      return resolved.type === 'array';
    })
    .map(([name]) => name);

  if (arrays.length === 0) return null;

  /**
   * A key named after the resource wins, because more than one array can be
   * present. `/voices` returns BOTH `voices` and `providers`; a
   * "single array property" rule returned null for it, and the CLI then read
   * an empty list and silently reported an unreachable voice as fine — the
   * same silent-pass this whole change exists to remove.
   */
  const resource = path.split('/').filter(Boolean).pop();
  if (resource && arrays.includes(resource)) return resource;

  /**
   * Otherwise the sole array, if there is one. Several arrays and no
   * resource-named key means this is not a list envelope at all —
   * `/providers/known` has four (stt, llm, tts, s2s) and no "the list" among
   * them — so picking one would be arbitrary.
   */
  return arrays.length === 1 ? arrays[0] : null;
}

function collect(spec) {
  const commands = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = methods[method];
      if (!op) continue;
      if (!op.operationId) {
        throw new Error(
          `${method.toUpperCase()} ${path} has no operationId; cannot name a command`,
        );
      }
      const parameters = op.parameters ?? [];
      const { fields, schemaName } = bodyFields(op, spec);
      commands.push({
        group: kebab(op.tags?.[0] ?? 'other'),
        name: kebab(op.operationId),
        operationId: op.operationId,
        method: method.toUpperCase(),
        path: stripVersion(path),
        // Derived from the path TEMPLATE, not from `parameters`. The spec
        // under-declares these — `getHumanCall` is `/voice/calls/{callId}`
        // with an empty parameters array, and `commandHumanCallLeg` documents
        // `{command}` but not `{controlId}`. The template is the only thing
        // that cannot be wrong about which placeholders a URL has, and a
        // missing one means the executor would send a literal `{callId}` to
        // the server. Descriptions are borrowed from `parameters` where the
        // spec does supply them.
        pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((match) => {
          const name = match[1];
          const declared = parameters.find((p) => p.in === 'path' && p.name === name);
          return { name, description: declared?.description ?? '' };
        }),
        queryParams: parameters
          .filter((p) => p.in === 'query')
          .map((p) => ({
            name: p.name,
            required: Boolean(p.required),
            description: p.description ?? '',
          })),
        body: bodyRequirement(op),
        responseListKey: responseListKey(op, spec, path),
        bodyFields: fields,
        bodySchema: schemaName ?? null,
        summary: op.summary ?? '',
        // The version-stripped path: the alias rule counts path segments, and
        // a leading `/v1` would make every root look like a sub-resource.
        restAlias: restAlias(method, stripVersion(path)),
      });
    }
  }

  // An alias is typed as `speko-cli <group> <alias>`, so rivalry is decided per
  // group: two operations answering to `speko-cli sms list` would make the short
  // form a coin toss, and the canonical name is always available regardless.
  //
  // AMONG RIVALS, THE SHALLOWEST PATH WINS. Refusing to choose is wrong when the
  // claimants are not peers: `GET /agents` and `GET /agents/{id}/analysis` both
  // read as a `list`, but only the first is what `speko-cli agents list` means.
  // The original rule refused, and when main added that endpoint plus
  // `/agents/{id}/analysis.csv`, the most obvious command in the CLI silently
  // lost its alias to two sub-resources nobody would have reached for.
  //
  // A genuine tie — two claimants at the same depth — still yields nothing, and
  // that is the case worth refusing: at equal depth there is no principled
  // winner, so a short form would be a coin toss again.
  const shallowest = new Map();
  const tied = new Set();
  for (const c of commands) {
    if (!c.restAlias) continue;
    const key = `${c.group}/${c.restAlias}`;
    const depth = pathDepth(c.path);
    const best = shallowest.get(key);
    if (best === undefined || depth < best) {
      shallowest.set(key, depth);
      tied.delete(key);
    } else if (depth === best) {
      tied.add(key);
    }
  }
  for (const c of commands) {
    const key = `${c.group}/${c.restAlias}`;
    const wins =
      Boolean(c.restAlias) && !tied.has(key) && pathDepth(c.path) === shallowest.get(key);
    c.aliases = wins ? [c.restAlias] : [];
    delete c.restAlias;
  }

  commands.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  return commands;
}

function render(commands) {
  const groups = [...new Set(commands.map((c) => c.group))].sort();
  const rows = commands
    .map((c) => {
      const parts = [
        `group: ${JSON.stringify(c.group)}`,
        `name: ${JSON.stringify(c.name)}`,
        `operationId: ${JSON.stringify(c.operationId)}`,
        `aliases: ${JSON.stringify(c.aliases)}`,
        `method: ${JSON.stringify(c.method)}`,
        `path: ${JSON.stringify(c.path)}`,
        `pathParams: ${JSON.stringify(c.pathParams)}`,
        `queryParams: ${JSON.stringify(c.queryParams)}`,
        `body: ${JSON.stringify(c.body)}`,
        `responseListKey: ${JSON.stringify(c.responseListKey)}`,
        `bodyFields: ${JSON.stringify(c.bodyFields)}`,
        `bodySchema: ${JSON.stringify(c.bodySchema)}`,
        `summary: ${JSON.stringify(c.summary)}`,
      ];
      return `  { ${parts.join(', ')} },`;
    })
    .join('\n');

  return `// GENERATED FILE — DO NOT EDIT.
//
// Produced by scripts/generate-commands.mjs from apps/docs/content/openapi.json.
// Regenerate with \`node scripts/generate-commands.mjs\`; \`--check\` fails when
// this file is out of date, which is what stops the CLI and the server from
// describing different APIs.
//
// ${commands.length} operations across ${groups.length} groups.

export interface CommandParam {
  readonly name: string;
  readonly description: string;
}

export interface CommandQueryParam extends CommandParam {
  readonly required: boolean;
}

export type BodyRequirement = 'required' | 'optional' | 'none';

export interface CommandBodyField {
  readonly name: string;
  /** One printable word; a nested object is named by its schema. */
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

export interface GeneratedCommand {
  /** Kebab-cased OpenAPI tag: the first word after \`speko\`. */
  readonly group: string;
  /** Kebab-cased operationId: the canonical subcommand. */
  readonly name: string;
  readonly operationId: string;
  /** Short REST forms, offered only where unambiguous within the group. */
  readonly aliases: readonly string[];
  readonly method: string;
  /** Version-stripped; the API client supplies the prefix. */
  readonly path: string;
  readonly pathParams: readonly CommandParam[];
  readonly queryParams: readonly CommandQueryParam[];
  readonly body: BodyRequirement;
  /**
   * For an operation returning a list, the property holding it — \`entries\`,
   * \`data\`, \`voices\` — or \`null\` for a bare array or a non-list.
   * Declared by the spec, so a client never has to guess.
   */
  readonly responseListKey: string | null;
  /** Top-level request-body fields, so \`--help\` can say what JSON to pass. */
  readonly bodyFields: readonly CommandBodyField[];
  /** The body's schema name in openapi.json, for the full definition. */
  readonly bodySchema: string | null;
  readonly summary: string;
}

export const COMMAND_GROUPS: readonly string[] = ${JSON.stringify(groups)};

export const COMMANDS: readonly GeneratedCommand[] = [
${rows}
];
`;
}

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
const output = render(collect(spec));

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT_PATH, 'utf8');
  } catch {
    console.error(
      'FAIL  src/generated/commands.ts is missing. Run: node scripts/generate-commands.mjs',
    );
    process.exit(1);
  }
  if (current !== output) {
    console.error(
      'FAIL  src/generated/commands.ts is stale — openapi.json changed without regenerating.\n' +
        '      Run: node packages/cli/scripts/generate-commands.mjs',
    );
    process.exit(1);
  }
  console.log('ok    src/generated/commands.ts matches openapi.json');
} else {
  writeFileSync(OUT_PATH, output);
  const count = output.match(/^ {2}\{ group:/gm)?.length ?? 0;
  console.log(`Wrote src/generated/commands.ts (${count} operations)`);
}
