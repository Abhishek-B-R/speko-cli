import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Source only. `tsc -p tsconfig.lib.json` emits the specs to `dist/` as
    // well, and vitest's default include matches compiled `.spec.js` — so
    // without this the suite silently runs twice, once against source and once
    // against whatever the last build happened to leave behind.
    include: ['src/**/*.spec.ts'],
  },
});
