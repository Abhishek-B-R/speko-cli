import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS_MARKER, ENV_EXAMPLE_PATH, runInit, SKILL_RELATIVE_PATH } from './init.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'speko-init-'));
const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

describe('runInit', () => {
  it('writes the skill, the env example and AGENTS.md', () => {
    const dir = scratch();
    const result = runInit(dir);

    expect(result.files.map((f) => f.outcome)).toEqual(['written', 'written', 'written']);
    expect(read(dir, SKILL_RELATIVE_PATH)).toContain('name: speko');
    expect(read(dir, ENV_EXAMPLE_PATH)).toContain('SPEKO_API_KEY=');
    expect(read(dir, 'AGENTS.md')).toContain(AGENTS_MARKER);
  });

  it('never writes a credential into the project', () => {
    // The token lives in the user's config directory. Anything secret written
    // here ends up in a commit, and a commit is forever.
    const dir = scratch();
    runInit(dir);
    const env = read(dir, ENV_EXAMPLE_PATH);

    expect(env).toMatch(/SPEKO_API_KEY=\s*$/m);
    expect(env).not.toMatch(/sk_live_/);
  });

  it('tells the agent that login needs a human', () => {
    // Otherwise an agent will try to authenticate some other way, or report the
    // project as broken.
    const dir = scratch();
    runInit(dir);
    const skill = read(dir, SKILL_RELATIVE_PATH);

    expect(skill).toContain('speko-cli whoami');
    expect(skill).toMatch(/needs a person in a browser/i);
  });

  it('documents the constraints that fail with opaque errors', () => {
    const dir = scratch();
    runInit(dir);
    const skill = read(dir, SKILL_RELATIVE_PATH);

    expect(skill).toContain('24000 Hz');
    expect(skill).toMatch(/managed/i);
  });

  it('keeps existing files instead of overwriting them', () => {
    const dir = scratch();
    runInit(dir);
    writeFileSync(join(dir, ENV_EXAMPLE_PATH), 'MY_OWN=1\n');

    const again = runInit(dir);
    expect(again.files.find((f) => f.path.endsWith(ENV_EXAMPLE_PATH))?.outcome).toBe('skipped');
    expect(read(dir, ENV_EXAMPLE_PATH)).toBe('MY_OWN=1\n');
  });

  it('replaces its own file when forced', () => {
    const dir = scratch();
    runInit(dir);
    writeFileSync(join(dir, ENV_EXAMPLE_PATH), 'MY_OWN=1\n');

    runInit(dir, { force: true });
    expect(read(dir, ENV_EXAMPLE_PATH)).toContain('SPEKO_API_KEY=');
  });

  it('appends to an existing AGENTS.md without touching what is there', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'AGENTS.md'), '# Rules\n\nUse pnpm, never npm.\n');

    runInit(dir);
    const agents = read(dir, 'AGENTS.md');
    expect(agents).toContain('Use pnpm, never npm.');
    expect(agents).toContain(AGENTS_MARKER);
  });

  it('updates its block in place rather than appending a second one', () => {
    // Agent instructions that say the same thing twice are how contradictory
    // guidance creeps in.
    const dir = scratch();
    writeFileSync(join(dir, 'AGENTS.md'), '# Rules\n\nUse pnpm.\n');
    runInit(dir);
    runInit(dir);
    runInit(dir);

    const agents = read(dir, 'AGENTS.md');
    expect(agents.split(AGENTS_MARKER).length - 1).toBe(1);
    expect(agents).toContain('Use pnpm.');
  });
});
