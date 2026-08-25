import { defineConfig, mergeConfig } from 'vitest/config'
import base from '@petshop/config/vitest'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // O `cron.test.ts` é puro, mas o `lease.test.ts` precisa de banco — e banco
      // próprio, porque o turbo roda as suítes dos pacotes em paralelo.
      env: { TEST_DATABASE_NAME: 'petshop_test_job_scheduler' },
      globalSetup: ['./tests/global-setup.ts'],
      fileParallelism: false,
    },
  }),
)
