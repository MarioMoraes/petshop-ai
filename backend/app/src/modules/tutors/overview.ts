import { withTenant } from '@petshop/db'
import type { TutorExport, TutorOverview } from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { notFound } from './errors.js'
import { openCipher } from './crypto.js'
import { toAddressResponse, toDateString } from './mapper.js'
import { getTutor } from './service.js'
import type { ActorContext } from './service.js'

/**
 * Visão 360º (MOD-TUTOR-07) e portabilidade LGPD (§5).
 *
 * A agregação de agenda, financeiro e comunicações depende de MOD-AGENDA, MOD-LEDGER
 * e MOD-CRM, que ainda não existem. Em vez de devolver arrays vazios — que a tela
 * leria como "este tutor não tem agendamento" —, a resposta traz `pendingModules`, e a
 * UI diz "ainda não disponível". Zero e desconhecido são coisas diferentes.
 *
 * `pets` continua vazio aqui de propósito, mesmo com MOD-PET pronto: os pets vivem no
 * pet-service, e a tela do tutor os busca em `GET /v1/pets?tutorId=`. Compor no
 * frontend custa uma requisição; compor aqui custaria o tutor-service ler a tabela de
 * outro módulo — e `pets_count`, que já paga esse preço, existe só porque a listagem
 * tem SLO de 300ms.
 */

const PENDING_MODULES = ['MOD-AGENDA', 'MOD-LEDGER', 'MOD-CRM'] as const

export async function getTutorOverview(
  tenantId: string,
  tutorId: string,
): Promise<TutorOverview> {
  const tutor = await getTutor(tenantId, tutorId)

  return {
    tutor,
    pets: [],
    appointments: [],
    finance: {
      // O saldo denormalizado já é mantido pelo consumidor de `lancamento.criado`;
      // o resto da agregação chega com o MOD-LEDGER.
      balance: tutor.balance,
      lastEntryAt: null,
      openInvoices: 0,
    },
    communications: [],
    pendingModules: [...PENDING_MODULES],
  }
}

/**
 * Portabilidade (LGPD art. 18, V): tudo o que o tenant guarda sobre o titular, em
 * claro. Por isso a leitura é auditada como `tutor.exported` — é uma extração
 * completa de PII, não uma consulta de tela.
 */
export async function exportTutor(actor: ActorContext, tutorId: string): Promise<TutorExport> {
  return withTenant(
    actor.tenantId,
    async (tx) => {
      const row = await tx.tutor.findFirst({
        where: { id: tutorId },
        include: { tagAssignments: { include: { tag: true } } },
      })
      if (!row) throw notFound()

      const [addresses, consents, cipher] = await Promise.all([
        tx.tutorAddress.findMany({ where: { tutorId } }),
        tx.tutorConsent.findMany({ where: { tutorId }, orderBy: { createdAt: 'asc' } }),
        openCipher(tx, actor.tenantId),
      ])

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'tutor.exported',
        entity: 'tutor',
        entityId: tutorId,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return {
        exportedAt: new Date().toISOString(),
        tutor: {
          id: row.id,
          personType: row.personType,
          fullName: row.fullName,
          socialName: row.socialName,
          legalName: row.legalName,
          cpf: row.cpfEncrypted ? cipher.decrypt(row.cpfEncrypted) : null,
          cnpj: row.cnpjEncrypted ? cipher.decrypt(row.cnpjEncrypted) : null,
          phone: row.phoneEncrypted ? cipher.decrypt(row.phoneEncrypted) : null,
          phoneAlt: row.phoneAltEncrypted ? cipher.decrypt(row.phoneAltEncrypted) : null,
          email: row.emailEncrypted ? cipher.decrypt(row.emailEncrypted) : null,
          birthDate: row.birthDate ? toDateString(row.birthDate) : null,
          // O campo livre entra inteiro: é onde a operação escreve o que não cabia
          // em nenhum campo, e o titular tem direito a ver (PRD §9).
          notes: row.notes,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
        },
        addresses: addresses.map((address) => ({ ...toAddressResponse(address, cipher) })),
        consents: consents.map((consent) => ({
          id: consent.id,
          channel: consent.channel,
          granted: consent.granted,
          purpose: consent.purpose,
          version: consent.version,
          source: consent.source,
          documentId: consent.documentId,
          createdAt: consent.createdAt.toISOString(),
        })),
        tags: row.tagAssignments.map(({ tag }) => ({
          key: tag.key,
          label: tag.label,
          color: tag.color,
          isSystem: tag.isSystem,
        })),
      }
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )
}
