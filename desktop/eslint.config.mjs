import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

export default [
  {
    // `resources/bin/` holds the PyInstaller ONEDIR bundle that
    // prebuild-fetch-amphi.ts drops in — 8000+ third-party files including
    // Playwright's `protocol.d.ts`, which trips prefer-namespace-keyword and
    // no-empty-object-type. It used to be a single opaque binary (onefile), so
    // nothing here matched `**/*.{ts,tsx}` and the dir needed no exclusion.
    // Scoped to `bin/` rather than all of `resources/` because
    // `resources/generate-icons.ts` is ours and must stay linted.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/release/**',
      '**/out/**',
      '**/resources/bin/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Ban nested ternaries: hard to read and maintain — break them into
      // if/else, a helper, or an extracted local variable.
      'no-nested-ternary': 'error',
    },
    settings: {
      react: { version: '18' },
    },
  },
]
