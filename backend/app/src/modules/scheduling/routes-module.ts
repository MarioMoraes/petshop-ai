import type { FastifyInstance } from 'fastify'
import { registerScheduleCatalogRoutes } from '../schedule-catalog/routes.js'
import { registerSchedulingRoutes } from './routes.js'
import { setAppointmentsPort } from '../schedule-catalog/port.js'
import { livePort } from './port-impl.js'
import { livePort as liveBillingPort } from './billing-port.js'
import { setBillingPort } from './gates.js'
import { setSchedulingPort } from '../pets/scheduling-port.js'
import { petSchedulingPort } from './pet-port.js'

/**
 * MOD-AGENDA — o catálogo da agenda e os agendamentos.
 *
 * **Duas pastas, e o nome da segunda é o registro de uma colisão.** O módulo tinha
 * `catalog` e `scheduling` enquanto era serviço; aqui `modules/catalog` já é o catálogo
 * de domínio do MOD-PET — espécie, raça, porte e pelagem —, e juntar os dois num
 * diretório só trocaria o significado de "catálogo" no meio do processo. Daí
 * `modules/schedule-catalog`: serviços, profissionais e bloqueios.
 *
 * **A fronteira entre as duas metades continua sendo a porta, e não a pasta.** O
 * catálogo não sabe que `appointments` existe: as três regras que dependem disso — o
 * AC-03 do serviço em uso, o AC-04 do desligamento e o AC-02 do bloqueio — perguntam
 * pela `AppointmentsPort`, que é ligada aqui. O que o catálogo importa da outra metade é
 * infraestrutura (catálogo de erro, guardas, validação), nunca regra de agendamento.
 */
export async function registerSchedulingModule(app: FastifyInstance): Promise<void> {
  setAppointmentsPort(livePort)
  // RN-11 ligado ao MOD-LEDGER: o limite de crédito que o petshop configura vale de
  // verdade. A porta lê `ledger_accounts` e `billing_settings` sob `withTenant`, e não
  // por HTTP — era assim antes da consolidação e continua sendo.
  setBillingPort(liveBillingPort)
  /**
   * **A pendência mais antiga da consolidação, fechada aqui.** O AC-02 de MOD-PET-05 —
   * pet com agendamento futuro não se transfere — estava escrito e testado desde o
   * MOD-PET, mas a porta que responde por ele nunca foi ligada em produção: só em teste.
   * A regra existia e não valia. Com a agenda no mesmo processo, ligar é uma linha.
   */
  setSchedulingPort(petSchedulingPort)

  await registerScheduleCatalogRoutes(app)
  await registerSchedulingRoutes(app)
}
