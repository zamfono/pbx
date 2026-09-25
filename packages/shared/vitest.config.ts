import { defineConfig } from 'vitest/config';

// Vitest 5 dropped "**/dist/**" from its default exclude list, so without this
// the compiled dist/*.test.js this package's own build produces would run
// alongside (and duplicate) the src/*.test.ts suites.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts']
  }
});
