import { defineConfig, mergeConfig } from 'vitest/config'
import base from '@petshop/config/vitest'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Banco próprio: o turbo roda as suítes dos pacotes em paralelo e todas
      // truncam as tabelas entre os testes.
      env: { TEST_DATABASE_NAME: 'petshop_test_gateway' },
      globalSetup: ['./tests/global-setup.ts'],
      fileParallelism: false,
    },
  }),
)
