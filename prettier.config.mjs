/**
 * @type {import("prettier").Config}
 */
const config = {
  printWidth: 80,
  trailingComma: 'none',
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  arrowParens: 'avoid',
  importOrder: [
    '<THIRD_PARTY_MODULES>',
    '',
    '^@zamfono/',
    '',
    '^\\$lib',
    '',
    '^[./]'
  ],
  importOrderCaseSensitive: false,
  importOrderParserPlugins: [
    'typescript',
    'classProperties',
    'decorators-legacy'
  ],
  plugins: ['@ianvs/prettier-plugin-sort-imports'],
  overrides: [
    {
      files: '*.svelte',
      options: {
        parser: 'svelte',
        plugins: [
          'prettier-plugin-svelte',
          '@ianvs/prettier-plugin-sort-imports'
        ]
      }
    }
  ]
};

export default config;
