import { notFound, redirect } from 'next/navigation'
import { Alert, Card, DataRow, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, PawPrintIcon, SyringeIcon } from '@/components/icons'
import { overdueMessage, overdueVaccines } from '@petshop/shared-types'
import { PortalFrame } from '../../frame'
import { PetForm } from './pet-form'
import { Timeline } from './timeline'
import { Vaccinations } from './vaccinations'
import {
  PortalError,
  readOwnPet,
  readOwnPetTimeline,
  readOwnPetVaccinations,
  readPortalContext,
} from '@/lib/portal-api'

/**
 * A ficha do pet, com a história dele embaixo (MOD-PORTAL-03 e 04).
 *
 * Uma tela só, e não duas com uma aba entre elas: o tutor abre isto para responder
 * "quando foi o último banho?", e a ficha é o cabeçalho dessa resposta, não um destino
 * concorrente. Rolar é mais barato que decidir.
 *
 * A ordem — alertas, ficha, vacinas, histórico — é a da urgência. A alergia é o que muda
 * uma decisão hoje; a data de nascimento não muda nada.
 */

export const dynamic = 'force-dynamic'

export default async function PortalPetPage({ params }: { params: Promise<{ petId: string }> }) {
  const { petId } = await params

  try {
    const [context, pet, timeline, vacinas] = await Promise.all([
      readPortalContext(),
      readOwnPet(petId),
      readOwnPetTimeline(petId, { limit: 10 }),
      // A carteira é um pedaço da tela, e não a tela: se ela falhar, a ficha abre sem ela.
      readOwnPetVaccinations(petId).catch(() => null),
    ])
    const vacinaAtrasada =
      vacinas && !pet.inMemoriam
        ? overdueMessage(overdueVaccines(vacinas.current, vacinas.today))
        : null

    return (
      <PortalFrame
        tenantName={context.tenant.name}
        titulo={pet.name}
        voltar={{ href: '/portal/pets', label: 'Meus pets' }}
        descricao={[pet.species, pet.breed, pet.ageLabel].filter(Boolean).join(' · ')}
        acao={pet.inMemoriam ? undefined : <PetForm pet={pet} />}
      >
        {pet.inMemoriam && (
          <Alert tone="accent" icon={<PawPrintIcon />} title="Em memória" role="status">
            A ficha do {pet.name} fica guardada aqui, como está. Se algo precisar mudar, fale com o{' '}
            {context.tenant.name}.
          </Alert>
        )}

        {pet.alerts.length > 0 && (
          <Alert
            tone={pet.alerts.some((alerta) => alerta.severity === 'CRITICAL') ? 'danger' : 'accent'}
            icon={<AlertTriangleIcon />}
            title="Atenção no atendimento"
            role="status"
          >
            <ul className="flex flex-col gap-1">
              {pet.alerts.map((alerta) => (
                <li key={`${alerta.kind}-${alerta.label}`}>
                  {alerta.kind === 'ALLERGY' ? 'Alergia a ' : ''}
                  <strong>{alerta.label}</strong>
                </li>
              ))}
            </ul>
          </Alert>
        )}

        {vacinaAtrasada && (
          <Alert tone="accent" icon={<SyringeIcon />} title={vacinaAtrasada} role="status">
            Fale com o {context.tenant.name} para marcar a próxima dose.
          </Alert>
        )}

        <Card>
          <SectionHead icon={<PawPrintIcon />} tone="icon-pet" title="A ficha" />
          <div className="mt-4 flex flex-col gap-1">
            <DataRow label="Sexo">{rotuloSexo(pet.sex)}</DataRow>
            <DataRow label="Nascimento">{rotuloNascimento(pet)}</DataRow>
            <DataRow label="Castrado">{rotuloTernario(pet.neutered)}</DataRow>
            <DataRow label="Porte">{pet.size}</DataRow>
            <DataRow label="Pelagem">{pet.coat ?? '—'}</DataRow>
            <DataRow label="Peso">{pet.weightKg === null ? '—' : `${pet.weightKg} kg`}</DataRow>
            {pet.notes && <DataRow label="Observações">{pet.notes}</DataRow>}
          </div>

          {/*
            A frase existe porque a tela mostra quatro campos que ela não deixa editar, e
            um campo travado sem explicação lê como defeito. Dizer por que — e para quem
            reclamar — é o que separa "não posso" de "não deu certo".
          */}
          <p className="hint border-line mt-4 border-t pt-3">
            Peso, porte, raça e pelagem são conferidos no balcão, porque entram no preço do serviço.
            Se algum estiver errado, avise o {context.tenant.name}.
          </p>
        </Card>

        {vacinas && <Vaccinations card={vacinas} />}

        <Timeline
          petId={pet.id}
          inicial={timeline}
          timezone={context.tenant.timezone}
          nome={pet.name}
        />
      </PortalFrame>
    )
  } catch (error) {
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    // 404 é a resposta tanto para o pet que não existe quanto para o de outro tutor
    // (RN-03). São o mesmo caso aqui também.
    if (error instanceof PortalError && error.status === 404) notFound()
    throw error
  }
}

function rotuloSexo(sexo: 'MALE' | 'FEMALE' | 'UNKNOWN'): string {
  if (sexo === 'MALE') return 'Macho'
  if (sexo === 'FEMALE') return 'Fêmea'
  return 'Não informado'
}

/** `null` é "não sabemos", e é diferente de "não". */
function rotuloTernario(valor: boolean | null): string {
  if (valor === null) return 'Não informado'
  return valor ? 'Sim' : 'Não'
}

function rotuloNascimento(pet: {
  birthDate: string | null
  birthDatePrecision: 'EXACT' | 'ESTIMATED' | 'UNKNOWN'
}): string {
  if (!pet.birthDate || pet.birthDatePrecision === 'UNKNOWN') return 'Não informado'
  const [ano, mes, dia] = pet.birthDate.split('-')
  const data = `${dia}/${mes}/${ano}`
  return pet.birthDatePrecision === 'ESTIMATED' ? `≈ ${data}` : data
}
