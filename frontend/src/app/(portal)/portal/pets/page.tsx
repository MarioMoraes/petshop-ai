import { redirect } from 'next/navigation'
import { EmptyState, SectionHead } from '@/components/ui'
import { PawPrintIcon } from '@/components/icons'
import { PortalFrame } from '../frame'
import { RowLink, RowStack, RowText } from '../list'
import { PortalError, readOwnPets, readPortalContext } from '@/lib/portal-api'
import type { PortalPetSummary } from '@petshop/shared-types'

/**
 * "Meus pets" (MOD-PORTAL-03).
 *
 * Cada pet é uma linha-alvo inteira, e não um texto com um link no fim: no celular o
 * polegar acerta a linha, não as 14px do nome. A pilha de cartões soltos virou um cartão
 * com linhas dentro em 2026-09-08, junto com o resto do Portal — o alvo continua do
 * mesmo tamanho, e a lista passou a ter o relevo que tem o menu do Início.
 *
 * O que cada linha mostra foi escolhido pela pergunta que o tutor faz ao abrir isto:
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
      descricao={vivos.length > 0 ? 'Toque em um pet para ver a ficha e o histórico.' : undefined}
    >
      {pets.length === 0 && (
        <EmptyState
          title="Nenhum pet por aqui ainda"
          description={`Quem cadastra os pets é o ${context.tenant.name}. Se algum estiver faltando, fale com eles.`}
        />
      )}

      {vivos.length > 0 && (
        <RowStack>
          {vivos.map((pet) => (
            <PetRow key={pet.id} pet={pet} timezone={context.tenant.timezone} />
          ))}
        </RowStack>
      )}

      {emMemoria.length > 0 && (
        <RowStack
          head={
            <SectionHead
              icon={<PawPrintIcon />}
              tone="icon-pet"
              title="Em memória"
              description="A ficha e o histórico continuam aqui."
            />
          }
        >
          {emMemoria.map((pet) => (
            <PetRow key={pet.id} pet={pet} timezone={context.tenant.timezone} />
          ))}
        </RowStack>
      )}
    </PortalFrame>
  )
}

function PetRow({ pet, timezone }: { pet: PortalPetSummary; timezone: string }) {
  return (
    <RowLink href={`/portal/pets/${pet.id}`} top>
      <Avatar pet={pet} />

      <RowText title={pet.name} hint={descreve(pet)}>
        {/*
          A terceira linha responde à pergunta que faz o tutor abrir esta tela: quando é
          o próximo, e — se não houver — quando foi o último. Ela é a única coisa aqui
          que muda de peso: o compromisso marcado vem em texto de leitura, o atendimento
          passado desce ao cinza da legenda.
        */}
        {pet.nextAppointment ? (
          <span className="mt-1 block text-sm">
            <span className="text-subtle">Próximo · </span>
            {formatoLongo(pet.nextAppointment.startsAt, timezone)}
            {pet.nextAppointment.services.length > 0 && (
              <span className="text-subtle"> · {pet.nextAppointment.services.join(', ')}</span>
            )}
          </span>
        ) : (
          pet.lastAttendanceAt && (
            <span className="hint mt-1 block">
              Último atendimento em {formatoCurto(pet.lastAttendanceAt, timezone)}
            </span>
          )
        )}
      </RowText>
    </RowLink>
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
        className="size-12 shrink-0 rounded-full object-cover"
        loading="lazy"
      />
    )
  }

  return (
    <span className="bg-chip text-subtle flex size-12 shrink-0 items-center justify-center rounded-full text-base font-semibold">
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
