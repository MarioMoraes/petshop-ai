import { defineConfig, mergeConfig } from 'vitest/config'
import base from '@petshop/config/vitest'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Banco próprio: o turbo roda as suítes dos pacotes em paralelo e todas
      // truncam as tabelas entre os testes.
      env: { TEST_DATABASE_NAME: 'petshop_test_db' },
      globalSetup: ['./tests/global-setup.ts'],
      // As tabelas são truncadas entre os testes; rodar arquivos em paralelo
      // faria um limpar o cenário do outro.
      fileParallelism: false,
    },
  }),
)
