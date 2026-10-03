import { defineConfig, mergeConfig } from 'vitest/config'
import base from '@petshop/config/vitest'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Banco próprio: o turbo roda as suítes dos pacotes em paralelo e todas
      // truncam as tabelas entre os testes.
      env: {
        TEST_DATABASE_NAME: 'petshop_test_gateway',
        // Broker, agendador e cache desligados **antes** de qualquer import. O harness
        // também os desliga, mas tarde demais para o teste que importa `src/` antes
        // dele: o `logger.ts` lê o ambiente na importação, o `loadEnv()` guarda em cache
        // o `.env` do globalSetup, e o check-out chamado direto publicava no RabbitMQ
        // de desenvolvimento — eventos de tenants que só existiam no banco de teste.
        DISABLE_EVENTS: 'true',
        DISABLE_JOBS: 'true',
        DISABLE_REDIS: 'true',
      },
      globalSetup: ['./tests/global-setup.ts'],
      fileParallelism: false,
    },
  }),
)
