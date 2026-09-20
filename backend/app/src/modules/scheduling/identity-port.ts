import type { TenantTransaction } from '@petshop/db'
import {
  NON_ATTENDING_ROLE_KEYS,
  WEEKDAYS,
  type BusinessHours,
  type ProfessionalRoleKey,
  type Weekday,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { invalidateScheduleCatalog } from '../../shared/redis.js'
import type {
  ProfessionalMirror,
  ProfessionalMirrorInput,
  SchedulingPort,
} from '../identity/scheduling-port.js'
import { OCCUPYING_STATUSES } from './conflicts.js'

/**
 * O que a identidade faz na agenda em nome dela — as RN-06 e RN-07 do MOD-IDENT.
 *
 * **RN-07, a leitura.** O desligamento do *profissional* já tinha a regra (AC-04 de
 * MOD-AGENDA-02, via `AppointmentsPort`); o que não tinha era o caminho da *equipe*.
 * Remover o vínculo deixava o profissional ativo e os agendamentos apontando para quem
 * não entra mais no sistema — sábado chegava sem ninguém para atender, e nada tinha
 * avisado. "Futuro" é relativo a **agora**, como nas outras portas da agenda: o que
 * bloqueia é o compromisso que ainda vai acontecer, nunca um banho de ontem.
 *
 * **RN-06, a escrita.** Atribuir `GROOMER`, `BATHER`, `VET` ou `DRIVER` abre a ficha da
 * pessoa na agenda. Era a regra mais antiga por ligar do módulo: `membership.is_professional`
 * está no schema desde o MOD-IDENT e ninguém escrevia a outra ponta, então o petshop que
 * contratava um banhista dava o papel a ele e **não o encontrava na agenda** — tinha de
 * recadastrá-lo à mão, num cadastro que nem ficava ligado ao usuário. O efeito colateral
 * era pior que o incômodo: sem `professionals.user_id` preenchido, a guarda da RN-07
 * logo acima nunca achava nada, e a regra que devia impedir a remoção de quem tem agenda
 * cheia era verdadeira no código e inerte na prática.
 */
export const identitySchedulingPort: SchedulingPort = {
  async listFutureProfessionalAppointments(tx, tenantId, userId) {
    /**
     * Do usuário para o profissional, aqui dentro.
     *
     * `findMany` e não `findFirst`: `professionals.user_id` não é único — o espelho da
     * RN-06 é criado por atribuição de papel, e um histórico de promoções pode ter
     * deixado mais de uma linha para a mesma pessoa. Somar as agendas das duas é o
     * comportamento certo, porque o agendamento aponta para uma delas.
     */
    const profissionais = await tx.professional.findMany({
      where: { tenantId, userId },
      select: { id: true },
    })
    if (profissionais.length === 0) return []

    const rows = await tx.appointment.findMany({
      where: {
        professionalId: { in: profissionais.map((profissional) => profissional.id) },
        startsAt: { gt: new Date() },
        status: { in: [...OCCUPYING_STATUSES] },
      },
      select: {
        id: true,
        startsAt: true,
        pet: { select: { name: true } },
        items: { select: { label: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { startsAt: 'asc' },
      // O corpo do 409 é lido por uma pessoa decidindo na tela da equipe. Vinte linhas
      // já são mais do que se confere antes de decidir; o que importa é a contagem.
      take: 20,
    })

    return rows.map((row) => ({
      id: row.id,
      startsAt: row.startsAt.toISOString(),
      petName: row.pet.name,
      serviceLabel: labelOf(row.items),
    }))
  },

  /**
   * RN-06 — a ficha de agenda de quem ganhou papel operacional.
   *
   * Três caminhos, nesta ordem, e a ordem é o que evita o homônimo e a lista dobrada:
   *
   * 1. **já tem ficha** — reativa e acerta o papel. Quem foi banhista, saiu e voltou
   *    como veterinário continua sendo a mesma linha, com o histórico dela;
   * 2. **adota** o cadastro sem dono de mesmo nome. É a mesma chave natural do
   *    MOD-IMPORT (nome do profissional), e existe porque o petshop cadastra a equipe na
   *    agenda antes de convidar cada um para o sistema: sem a adoção, "Maria" viraria
   *    duas — e não há fusão de profissionais neste produto. **Dois cadastros com o
   *    mesmo nome não adotam nenhum**, pela razão que a porta do tutor do MOD-IMPORT já
   *    fixou: escolher o primeiro penduraria a agenda de sábado na pessoa errada;
   * 3. **cria**, pronta para agendar.
   */
  async mirrorProfessional(tx, tenantId, input) {
    // `full_name` tem 120 e `display_name` tem 60 — o corte é aqui, e não no banco.
    const displayName = input.displayName.trim().slice(0, 60)

    const proprios = await tx.professional.findMany({
      where: { tenantId, userId: input.userId, deletedAt: null },
      // Ativo primeiro: um histórico de promoções pode ter deixado mais de uma linha, e
      // a que vale é a que está de pé.
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, roleKey: true, active: true },
    })

    const proprio = proprios[0]
    if (proprio) {
      if (proprio.active && proprio.roleKey === input.roleKey) return null

      await tx.professional.update({
        where: { id: proprio.id },
        data: { active: true, roleKey: input.roleKey },
      })
      const action = proprio.active ? 'UPDATED' : 'REACTIVATED'
      await auditMirror(tx, tenantId, input, proprio.id, action, {
        before: { active: proprio.active, roleKey: proprio.roleKey },
      })
      return { professionalId: proprio.id, action }
    }

    const adotado = await adoptable(tx, tenantId, displayName)
    if (adotado) {
      await tx.professional.update({
        where: { id: adotado.id },
        data: { userId: input.userId, roleKey: input.roleKey, active: true },
      })
      await auditMirror(tx, tenantId, input, adotado.id, 'ADOPTED', {
        before: { displayName: adotado.displayName, roleKey: adotado.roleKey, userId: null },
      })
      return { professionalId: adotado.id, action: 'ADOPTED' }
    }

    const criado = await tx.professional.create({
      data: {
        tenantId,
        userId: input.userId,
        displayName,
        roleKey: input.roleKey,
        createdBy: input.actorUserId,
      },
      select: { id: true },
    })
    await seedServices(tx, tenantId, criado.id, input.roleKey)
    await seedSchedule(tx, tenantId, criado.id)
    await auditMirror(tx, tenantId, input, criado.id, 'CREATED', {})
    return { professionalId: criado.id, action: 'CREATED' }
  },

  /**
   * O papel operacional saiu. A ficha é **desativada**, nunca apagada.
   *
   * `deleted_at` continuaria sendo o que o AC-04 do MOD-AGENDA não faz nem pela tela: o
   * atendimento de março aponta para esta linha, e o histórico do pet lê o nome dela.
   * Inativo é o suficiente — some do assistente de marcar horário e do painel do dia.
   */
  async dropProfessionalMirror(tx, tenantId, input) {
    const ativo = await tx.professional.findFirst({
      where: { tenantId, userId: input.userId, deletedAt: null, active: true },
      select: { id: true, displayName: true, roleKey: true },
    })
    if (!ativo) return null

    await tx.professional.update({ where: { id: ativo.id }, data: { active: false } })
    await recordAudit(tx, {
      tenantId,
      actorUserId: input.actorUserId,
      action: 'professional.mirror_dropped',
      entity: 'professional',
      entityId: ativo.id,
      before: { active: true, roleKey: ativo.roleKey },
      after: { active: false, displayName: ativo.displayName, source: 'membership' },
    })
    return { professionalId: ativo.id, action: 'DEACTIVATED' }
  },

  async announceProfessionalChange(tenantId, mirror) {
    await invalidateScheduleCatalog(tenantId, [mirror.professionalId])
    await publishEvent('agenda.profissional.alterado', {
      tenantId,
      professionalId: mirror.professionalId,
      // O evento fala o vocabulário do catálogo, que é quem o publica pela tela.
      action: mirror.action === 'DEACTIVATED' ? 'DEACTIVATED' : 'UPDATED',
    })
  },
}

/**
 * O cadastro sem dono que tem exatamente este nome — ou nenhum.
 *
 * A comparação é sem acento e sem caixa, a mesma forma do `normalize` do MOD-IMPORT:
 * "Luís" digitado na agenda e "Luis" vindo do cadastro do Clerk são a mesma pessoa, e
 * deixar que não fossem devolveria a lista dobrada que a adoção existe para evitar. O
 * filtro final é em memória de propósito — `unaccent` não está instalado no banco, e o
 * conjunto aqui é a equipe de um petshop.
 */
async function adoptable(
  tx: TenantTransaction,
  tenantId: string,
  displayName: string,
): Promise<{ id: string; displayName: string; roleKey: string } | null> {
  const alvo = semAcento(displayName)
  if (!alvo) return null

  const candidatos = await tx.professional.findMany({
    where: { tenantId, userId: null, deletedAt: null },
    select: { id: true, displayName: true, roleKey: true },
  })
  const casam = candidatos.filter((row) => semAcento(row.displayName) === alvo)
  return casam.length === 1 ? (casam[0] ?? null) : null
}

/** Sem acento, sem caixa, sem espaço nas pontas — a mesma regra do `normalize` do MOD-IMPORT. */
function semAcento(raw: string): string {
  return raw.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

/**
 * A ficha nasce podendo atender — e o motorista nasce sem serviço nenhum.
 *
 * Habilitar em todos os serviços ativos é a mesma receita da etapa 3 do onboarding, e
 * pela mesma razão: profissional sem serviço não aparece no assistente de marcar
 * horário, e a pessoa que acabou de entrar na equipe precisaria de uma segunda visita a
 * `/agenda/profissionais` para existir. Quem atende menos que tudo é ajustado lá.
 *
 * O `DRIVER` é a exceção nomeada (`NON_ATTENDING_ROLE_KEYS`): motorista não atende pet, e
 * habilitá-lo em "Banho" o ofereceria como banhista no assistente.
 */
async function seedServices(
  tx: TenantTransaction,
  tenantId: string,
  professionalId: string,
  roleKey: ProfessionalRoleKey,
): Promise<void> {
  if ((NON_ATTENDING_ROLE_KEYS as readonly string[]).includes(roleKey)) return

  const servicos = await tx.service.findMany({
    where: { deletedAt: null, active: true },
    select: { id: true },
  })
  if (servicos.length === 0) return

  await tx.professionalService.createMany({
    data: servicos.map((servico) => ({ tenantId, professionalId, serviceId: servico.id })),
  })
}

/** A jornada nasce igual ao horário de funcionamento — de novo, a receita do onboarding. */
async function seedSchedule(
  tx: TenantTransaction,
  tenantId: string,
  professionalId: string,
): Promise<void> {
  const settings = await tx.tenantSettings.findFirst({
    where: { tenantId },
    select: { businessHours: true },
  })
  const janelas = businessHoursToWindows(settings?.businessHours)
  if (janelas.length === 0) return

  await tx.professionalSchedule.createMany({
    data: janelas.map((janela) => ({ tenantId, professionalId, ...janela })),
  })
}

/**
 * `WEEKDAYS` começa na segunda, porque é assim que a semana é lida na tela; a coluna
 * `professional_schedules.weekday` é 0 = domingo, a convenção do Postgres e do
 * `Date.getDay()`. O índice do array **não** serve como dia da semana — usá-lo
 * deslocaria a jornada de todo mundo em um dia, calado.
 */
const ISO_WEEKDAY: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

/**
 * Horário de funcionamento → faixas de jornada.
 *
 * Lê o JSON com desconfiança: `tenant_settings.business_hours` é `Json` no Prisma, e um
 * tenant provisionado antes da coluna existir devolve `null`. Dia fechado, mal formado
 * ou invertido simplesmente não gera faixa — o profissional nasce sem jornada naquele
 * dia, que é melhor que nascer com uma jornada inventada.
 */
function businessHoursToWindows(
  businessHours: unknown,
): { weekday: number; startsAtMin: number; endsAtMin: number }[] {
  if (!businessHours || typeof businessHours !== 'object') return []
  const semana = businessHours as Partial<BusinessHours>

  return WEEKDAYS.flatMap((dia) => {
    const horas = semana[dia]
    if (!horas || horas.closed) return []

    const startsAtMin = toMinutes(horas.opensAt)
    const endsAtMin = toMinutes(horas.closesAt)
    if (startsAtMin === null || endsAtMin === null || endsAtMin <= startsAtMin) return []

    return [{ weekday: ISO_WEEKDAY[dia], startsAtMin, endsAtMin }]
  })
}

function toMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * A trilha do espelho, com o papel que a originou.
 *
 * Ação própria, e não `professional.created`: quem lê a trilha precisa distinguir o
 * cadastro que alguém abriu na tela da agenda daquele que nasceu de uma atribuição de
 * papel — no segundo, o ator mexeu na equipe e a agenda mudou junto.
 */
async function auditMirror(
  tx: TenantTransaction,
  tenantId: string,
  input: ProfessionalMirrorInput,
  professionalId: string,
  action: ProfessionalMirror['action'],
  extra: { before?: Record<string, unknown> },
): Promise<void> {
  await recordAudit(tx, {
    tenantId,
    actorUserId: input.actorUserId,
    action: 'professional.mirrored',
    entity: 'professional',
    entityId: professionalId,
    before: extra.before ?? null,
    after: {
      mirror: action,
      roleKey: input.roleKey,
      userId: input.userId,
      displayName: input.displayName.trim().slice(0, 60),
    },
  })
}

/** "Banho e tosa" com um item, "Banho e mais 2" com vários — como em `pet-port.ts`. */
function labelOf(items: { label: string }[]): string {
  const first = items[0]?.label ?? 'Atendimento'
  const rest = items.length - 1
  return rest > 0 ? `${first} e mais ${rest}` : first
}
