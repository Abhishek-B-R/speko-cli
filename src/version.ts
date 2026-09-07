import pkg from '../package.json' with { type: 'json' };

/**
 * The published version, read from the manifest rather than duplicated as a
 * literal — a hand-maintained copy drifts, and this string goes out in the
 * User-Agent that the devices page shows the user.
 *
 * `package.json` is listed in `files`, so this resolves from `dist/` too.
 */
export const CLI_VERSION: string = pkg.version;
