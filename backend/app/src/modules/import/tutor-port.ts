import {
  CreateTutorSchema,
  ListTutorsQuerySchema,
  UpdateTutorSchema,
  type CreateTutorInput,
  type UpdateTutorInput,
} from '@petshop/shared-types'
import { classifyQuery } from '../tutors/search.js'
import { createTutor, listTutors, updateTutor, type ActorContext } from '../tutors/service.js'

/**
 * A porta para o MOD-TUTOR.
 *
 * Nenhum `INSERT` de tutor mora no MOD-IMPORT: o cliente importado nasce pelo mesmo
 * `createTutor` do formulário, com a mesma cifragem de CPF e telefone, o mesmo registro
 * de consentimento, o mesmo evento e a mesma trilha. Um caminho de escrita próprio
 * seria mais rápido de escrever e criaria uma segunda verdade por tabela — a que
 * envelhece quando a regra muda de um lado só.
 *
 * **O consentimento entra com origem `IMPORT`**, e é a única diferença real entre a
 * linha importada e a digitada. O aceite que veio da base antiga é prova de segunda
 * mão: existiu, mas não neste sistema, e quem ler a trilha meses depois precisa
 * distinguir isso de alguém que marcou a caixa numa tela nossa. O padrão dos
 * consentimentos de **marketing** é NÃO — só uma coluna dizendo "sim" os liga.
 */

export interface TutorRef {
  id: string
  fullName: string
}

export interface TutorPort {
  /**
   * Acha o cliente por CPF, CNPJ, celular ou e-mail — nunca por nome.
   *
   * É o mesmo caminho da busca de balcão (`classifyQuery` + `listTutors`), e a recusa
   * do nome é deliberada: a busca por texto é fuzzy, e um "Maria Silva" que casa por
   * similaridade penduraria o pet da Maria na ficha da Mariana. Chave natural que não
   * identifica sozinha não é chave.
   */
  findByRef(tenantId: string, ref: string): Promise<TutorRef | null>
  create(actor: ActorContext, input: CreateTutorInput): Promise<TutorRef>
  update(actor: ActorContext, tutorId: string, patch: UpdateTutorInput): Promise<void>
}

function createInProcessPort(): TutorPort {
  return {
    async findByRef(tenantId, ref) {
      const shape = classifyQuery(ref)
      if (shape.kind === 'text' || shape.kind === 'none') return null

      const query = ListTutorsQuerySchema.parse({ q: ref, limit: 2 })
      const page = await listTutors(tenantId, query)

      /**
       * Dois cadastros com o mesmo contato existe, e a resposta certa é **nenhum**.
       *
       * O celular da família aparece em duas fichas mais vezes do que se gostaria, e
       * escolher a primeira penduraria o pet no irmão errado em silêncio. A linha vira
       * erro, e o relatório manda unificar as duas fichas antes — que é o conserto de
       * verdade, e existe em tela (MOD-TUTOR-07).
       */
      if (page.data.length !== 1) return null

      const tutor = page.data[0] as (typeof page.data)[number]
      return { id: tutor.id, fullName: tutor.displayName }
    },

    async create(actor, input) {
      const tutor = await createTutor(actor, CreateTutorSchema.parse(input), {
        consentSource: 'IMPORT',
      })
      return { id: tutor.id, fullName: tutor.displayName }
    },

    async update(actor, tutorId, patch) {
      await updateTutor(actor, tutorId, UpdateTutorSchema.parse(patch))
    },
  }
}

let port: TutorPort | null = null

export function getTutorPort(): TutorPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setTutorPort(next: TutorPort | null): void {
  port = next
}
