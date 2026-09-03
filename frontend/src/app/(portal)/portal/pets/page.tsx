import Link from 'next/link'
import { redirect } from 'next/navigation'
import { EmptyState } from '@/components/ui'
import { PortalFrame } from '../frame'
import { PortalError, readOwnPets, readPortalContext } from '@/lib/portal-api'
import type { PortalPetSummary } from '@petshop/shared-types'

/**
 * "Meus pets" (MOD-PORTAL-03).
 *
 * Cada pet é um cartão-alvo inteiro, e não uma linha com um link no fim: no celular o
 * polegar acerta o cartão, não o texto de 14px.
 *
 * O que cada cartão mostra foi escolhido pela pergunta que o tutor faz ao abrir isto:
 * **quando é o próximo, e quando foi o último**. Espécie, raça e idade servem para
 * reconhecer de qual pet se trata quando há mais de um; nada além disso cabe aqui.
 */

export const dynamic = 'force-dynamic'

export default async function PortalPetsPage() {
  let context
  let pets: PortalPetSummary[]

  try {
    ;[context, { pets }] = await Promise.all([readPortalContext(), readOwnPets()])
  } catch (error) {
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    throw error
  }

  const vivos = pets.filter((pet) => !pet.inMemoriam)
  const emMemoria = pets.filter((pet) => pet.inMemoriam)

  return (
    <PortalFrame
      tenantName={context.tenant.name}
      titulo="Meus pets"
      voltar={{ href: '/portal/inicio', label: 'Início' }}
      descricao={
        vivos.length > 0 ? 'Toque em um pet para ver a ficha e o histórico.' : undefined
      }
    >
      {pets.length === 0 && (
        <EmptyState
          title="Nenhum pet por aqui ainda"
          description={`Quem cadastra os pets é o ${context.tenant.name}. Se algum estiver faltando, fale com eles.`}
        />
      )}

      {vivos.length > 0 && (
        <ul className="flex flex-col gap-3">
          {vivos.map((pet) => (
            <PetCard key={pet.id} pet={pet} timezone={context.tenant.timezone} />
          ))}
        </ul>
      )}

      {emMemoria.length > 0 && (
        <section className="flex flex-col gap-3">
          <p className="section-eyebrow">Em memória</p>
          <ul className="flex flex-col gap-3">
            {emMemoria.map((pet) => (
              <PetCard key={pet.id} pet={pet} timezone={context.tenant.timezone} />
            ))}
          </ul>
        </section>
      )}
    </PortalFrame>
  )
}

function PetCard({ pet, timezone }: { pet: PortalPetSummary; timezone: string }) {
  return (
    <li>
      <Link
        href={`/portal/pets/${pet.id}`}
        className="card hover:border-ink/20 block p-4 transition-colors"
      >
        <div className="flex items-center gap-4">
          <Avatar pet={pet} />

          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{pet.name}</p>
            <p className="hint truncate">{descreve(pet)}</p>
          </div>
        </div>

        {pet.nextAppointment ? (
          <p className="border-line mt-3 border-t pt-3 text-sm">
            <span className="text-subtle">Próximo · </span>
            {formatoLongo(pet.nextAppointment.startsAt, timezone)}
            {pet.nextAppointment.services.length > 0 && (
              <span className="text-subtle"> · {pet.nextAppointment.services.join(', ')}</span>
            )}
          </p>
        ) : (
          pet.lastAttendanceAt && (
            <p className="border-line text-subtle mt-3 border-t pt-3 text-sm">
              Último atendimento em {formatoCurto(pet.lastAttendanceAt, timezone)}
            </p>
          )
        )}
      </Link>
    </li>
  )
}

/**
 * O retrato, ou as iniciais.
 *
 * A URL da foto é assinada e vence em 15 minutos, então nada disto é cacheável — e a
 * ausência dela é o caso comum, não a exceção: a maioria das fichas nasce sem foto.
 */
function Avatar({ pet }: { pet: PortalPetSummary }) {
  if (pet.photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- URL assinada e efêmera; o otimizador do Next a buscaria de novo depois de vencida.
      <img
        src={pet.photoUrl}
        alt=""
        className="size-14 shrink-0 rounded-full object-cover"
        loading="lazy"
      />
    )
  }

  return (
    <span className="bg-chip text-subtle flex size-14 shrink-0 items-center justify-center rounded-full text-lg font-semibold">
      {pet.name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function descreve(pet: PortalPetSummary): string {
  return [pet.species, pet.breed, pet.ageLabel].filter(Boolean).join(' · ')
}

function formatoLongo(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

function formatoCurto(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, dateStyle: 'short' }).format(new Date(iso))
}
