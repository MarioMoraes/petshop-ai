import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/** Preset compartilhado por todos os pacotes do monorepo (SPEC §11). */
export default tseslint.config(
  { ignores: ['dist/**', '.next/**', 'coverage/**', '**/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
