const tseslint = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const jestPlugin = require('eslint-plugin-jest');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['node_modules/**', 'build/**', 'coverage/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        node: true,
        es2021: true,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      jest: jestPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...jestPlugin.configs.recommended.rules,
      ...prettierConfig.rules,
      // Hier können spezifische Regeln hinzugefügt oder überschrieben werden
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    languageOptions: {
      globals: {
        ...jestPlugin.environments.globals.globals,
      },
    },
  },
];
