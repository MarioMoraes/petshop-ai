import type { TenantTransaction } from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  TAXI_FAILURE_REASON_TUTOR_TEXT,
  type TaxiFailureReason,
} from '@petshop/shared-types'

/**
 * As variáveis de uma corrida, prontas para o template (MOD-CRM-09).
 *
 * Irmão de `appointment-vars.ts`, e com as mesmas duas obrigações: entregar a data já
 * formatada no fuso do tenant, e falar do pet pelo nome. O que é próprio daqui:
 *
 * - **`taxi.janela` é a promessa, não o horário exato.** O motorista sai às 8h10 e o
 *   trânsito decide o resto; o que o tutor precisa saber é entre que horas ficar em
 *   casa. É a mesma janela que o MOD-TAXI já grava na corrida e mede como aderência.
 * - **`taxi.motivo` nunca é o enum** (AC-03). `NO_ONE_HOME` numa mensagem de WhatsApp
 *   não é linguagem de gente, e "Ninguém atendeu" — o rótulo do painel interno — soa
 *   como acusação quando chega no celular de quem estava no banho.
 */

export interface TaxiVariables {
  tutorId: string
  petId: string
  variables: Record<string, string>
}

export async function loadTaxiVariables(
  tx: TenantTransaction,
  rideId: string,
): Promise<TaxiVariables | null> {
  const ride = await tx.taxiRide.findUnique({
    where: { id: rideId },
    select: {
      tutorId: true,
      petId: true,
      windowStartsAt: true,
      windowEndsAt: true,
      failureReason: true,
      pet: { select: { name: true } },
    },
  })
  if (!ride) return null

  const settings = await tx.tenantSettings.findFirst({ select: { timezone: true } })
  const timezone = settings?.timezone ?? DEFAULT_TIMEZONE

  const reason = ride.failureReason as TaxiFailureReason | null

  return {
    tutorId: ride.tutorId,
    petId: ride.petId,
    variables: {
      // Uma corrida é de **um** pet — a van leva vários, mas cada um tem a sua linha em
      // `taxi_rides`. Por isso não há a consolidação de irmãos que o agendamento faz: o
      // agrupamento de dois pets do mesmo tutor sai da RN-08, na janela de 5 minutos, e
      // não daqui.
      'pets.lista': ride.pet.name,
      'taxi.janela': formatWindow(ride.windowStartsAt, ride.windowEndsAt, timezone),
      'taxi.motivo': reason ? TAXI_FAILURE_REASON_TUTOR_TEXT[reason] : '',
    },
  }
}

/**
 * "entre 8h e 9h", ou "às 8h" quando a janela é de um instante só.
 *
 * Sem minutos quando são zero: "entre 8h e 9h" é como se fala, "entre 08:00 e 09:00" é
 * como um sistema escreve. A grade da agenda é de 15 minutos, então "entre 8h15 e 9h15"
 * também acontece e também precisa sair legível.
 */
function formatWindow(start: Date, end: Date, timeZone: string): string {
  const from = formatTime(start, timeZone)
  const to = formatTime(end, timeZone)
  return from === to ? `às ${from}` : `entre ${from} e ${to}`
}

function formatTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant)

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00'

  return minute === '00' ? `${hour}h` : `${hour}h${minute}`
}
