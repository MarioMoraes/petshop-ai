import type { FastifyInstance } from 'fastify'
import { registerAttendanceRoutes } from '../attendances/routes.js'
import { registerPrescriptionRoutes } from '../prescriptions/routes.js'
import { registerRecordRoutes } from './routes.js'

/**
 * MOD-PRONT — o prontuário de segurança, o atendimento e o receituário.
 *
 * **A fatia que aposentou a exceção mais frágil do `proxy.ts`.** Enquanto isto era
 * serviço, o roteamento dele era por **sufixo** sob `/v1/pets/:id/…` — `/safety-record`,
 * `/alerts`, `/timeline` e mais seis —, conferido antes do prefixo do MOD-PET. Aquilo só
 * funcionava porque nenhuma rota do módulo de pets casava com esses sufixos, e no dia em
 * que alguém registrasse uma que casasse o Fastify preferiria a do módulo e a rota
 * sumiria sem erro nenhum. Agora as duas famílias estão na mesma árvore de rotas e o
 * conflito, se houver, aparece no boot.
 *
 * **O parâmetro se chama `:petId` aqui e `:id` no MOD-PET, e os dois convivem.** O
 * `find-my-way` aceita nomes diferentes na mesma posição — foi verificado antes da
 * migração, não presumido. Renomear seria churn cosmético dentro de uma fatia que
 * precisa preservar comportamento.
 */
export async function registerMedicalRecordRoutes(app: FastifyInstance): Promise<void> {
  await registerRecordRoutes(app)
  await registerAttendanceRoutes(app)
  await registerPrescriptionRoutes(app)
}
