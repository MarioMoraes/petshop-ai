import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FlatCompat } from '@eslint/eslintrc'

/**
 * Regras do Next por cima do preset do monorepo. As específicas do Next pegam
 * problemas que o TypeScript não vê — `key` faltando em lista, `<img>` sem
 * otimização, import de `next/document` fora do lugar.
 */
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) })

export default [
  { ignores: ['.next/**', 'node_modules/**'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
]
