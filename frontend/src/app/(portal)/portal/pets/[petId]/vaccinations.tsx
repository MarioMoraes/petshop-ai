import {
  VACCINATION_DUE_SOON_DAYS,
  VACCINATION_STATUS_LABELS,
  addDays,
  type Vaccination,
  type VaccinationCard,
} from '@petshop/shared-types'
import { Badge, SectionHead } from '@/components/ui'
import { SyringeIcon } from '@/components/icons'
import { RowItem, RowStack } from '../../list'

/**
 * A carteira de vacinação do pet (MOD-PRONT-08, RN-09).
 *
 * A dose **vigente** de cada vacina, com a data da próxima: é o que o tutor procura
 * quando abre isto — "a antirrábica está em dia?". As doses antigas, já superadas, ficam
 * no histórico do petshop; aqui elas só repetiriam a mesma vacina com datas velhas.
 *
 * As datas chegam como `YYYY-MM-DD` e são lidas como texto, sem passar por `Date`: dia de
 * vacina não tem hora, e convertê-lo no fuso do celular o empurraria para a véspera.
 */
export function Vaccinations({ card }: { card: VaccinationCard }) {
  const head = (
    <SectionHead
      icon={<SyringeIcon />}
      tone="icon-pet"
      title="Carteira de vacinação"
      description={
        card.current.length === 0
          ? 'Nenhuma vacina registrada ainda. Leve a carteira de papel no próximo atendimento e a equipe a transcreve aqui.'
          : undefined
      }
    />
  )

  if (card.current.length === 0) return <RowStack head={head} />

  return (
    <RowStack head={head}>
      {card.current.map((dose) => (
        <Dose key={dose.id} dose={dose} today={card.today} />
      ))}
    </RowStack>
  )
}

function Dose({ dose, today }: { dose: Vaccination; today: string }) {
  const atrasada = dose.nextDoseAt !== null && dose.nextDoseAt < today
  const emBreve =
    !atrasada && dose.nextDoseAt !== null && dose.nextDoseAt <= addDays(today, VACCINATION_DUE_SOON_DAYS)

  return (
    <RowItem top>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <span>{dose.vaccineLabel}</span>
          {atrasada && <Badge tone="danger">{VACCINATION_STATUS_LABELS.OVERDUE}</Badge>}
          {emBreve && <Badge tone="accent">{VACCINATION_STATUS_LABELS.DUE_SOON}</Badge>}
        </p>
        <p className="text-subtle text-sm">
          Aplicada em {data(dose.appliedAt)}
          {dose.nextDoseAt ? ` · próxima dose em ${data(dose.nextDoseAt)}` : ' · dose única'}
        </p>
        {(dose.batch || dose.vetName || dose.externalClinic) && (
          <p className="text-subtle text-xs">
            {[
              dose.vetName,
              dose.externalClinic,
              dose.batch && `lote ${dose.batch}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </div>
    </RowItem>
  )
}

function data(iso: string): string {
  return iso.split('-').reverse().join('/')
}
