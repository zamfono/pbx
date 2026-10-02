// noinspection SpellCheckingInspection
//
import eslint from '@eslint/js';
import prettier from 'eslint-plugin-prettier/recommended';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'build',
      '*.*',
      // `*.*` matches the directory name too; the CI scripts in it are linted like any other.
      '!.github',
      '**/generated/**',
      '**/build/**',
      '**/dist/**',
      '**/.svelte-kit/**',
      // Each package's tsconfig `include`/`rootDir` covers only its own src,
      // so these per-package vitest configs have no TS project.
      'packages/*/vitest.config.ts'
    ]
  },
  eslint.configs.all,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  ...svelte.configs.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      'prettier/prettier': [
        'error',
        {},
        {
          usePrettierrc: true
        }
      ],
      'array-callback-return': [
        'error',
        {
          checkForEach: true
        }
      ],
      camelcase: [
        'error',
        {
          allow: []
        }
      ],
      'func-style': [
        'error',
        'declaration',
        {
          allowArrowFunctions: true
        }
      ],
      // Note: The first element of the array is for the rule severity!
      // The other elements in the array are the identifiers that you want to disallow.
      'id-denylist': ['error'],
      'max-params': [
        'error',
        {
          max: 5
        }
      ],
      'one-var': ['error', 'never'],
      radix: ['error', 'as-needed'],
      'no-magic-numbers': [
        'error',
        {
          ignore: [0, 1, -1]
        }
      ],
      'max-lines-per-function': [
        'error',
        {
          max: 75,
          skipBlankLines: true,
          skipComments: true
        }
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:\\.\\./){2}',
              message:
                "Two or more directories up, import through the package's subpath imports (package.json \"imports\") instead, e.g. '#lib/server/db.js' in packages/api."
            }
          ]
        }
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true
        }
      ],
      ...[
        'capitalized-comments',
        // TypeScript's definite-assignment analysis already refuses a read before the first
        // write, and with `no-undef-init` this rule would leave `let x: T | undefined;` no legal
        // spelling at all.
        'init-declarations',
        'sort-keys',
        'max-statements',
        'no-continue',
        'no-plusplus',
        'no-ternary',
        'no-undefined',
        'prefer-destructuring',
        'sort-imports'
      ].reduce((rules, name) => {
        rules[name] = 'off';
        return rules;
      }, {})
    }
  },
  {
    // The plain JavaScript files are Node scripts and configs, run by Node.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    // Command-line scripts, whose output is what they print.
    files: [
      'scripts/**',
      '.github/scripts/**',
      'packages/api/scripts/**',
      'db/migrate.ts'
    ],
    rules: {
      'no-console': 'off'
    }
  },
  {
    files: ['packages/api/**/*.svelte'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        parser: tseslint.parser
      }
    },
    rules: {
      'svelte/prefer-const': ['error']
    }
  },
  {
    // Size limits measure production maintainability, and their only remedy is extraction. A test
    // file grows with the cases it covers, a vitest `describe` is a function holding every case in
    // it, and pulling a single case's setup into a named helper scatters the arrange/act/assert a
    // reader follows top to bottom. Fixture data is literal for the same reason: a timestamp or a
    // uid in a test is the input, not an unexplained constant.
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'no-magic-numbers': 'off',
      // `expect(someMock)` passes the method reference to an assertion that never invokes it, so
      // the unintended-`this` hazard the rule guards against cannot occur.
      '@typescript-eslint/unbound-method': 'off'
    }
  }
);
