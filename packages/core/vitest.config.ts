import { defineConfig } from 'vitest/config';

// Transformed modules are cached in this package's own `node_modules/.vite`, not copied into a
// fresh directory under the OS temp dir on every run, which a run that is killed leaves behind.
export default defineConfig({
  test: {
    fsModuleCache: true,
    fsModuleCachePath: 'node_modules/.vite/vitest'
  }
});
