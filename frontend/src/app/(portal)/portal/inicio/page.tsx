import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatBRL, portalCreditCents, portalOwesCents } from '@petshop/shared-types'
import { Card, DataRow } from '@/components/ui'
import { PortalFrame } from '../frame'
import { PortalError, readPortalContext } from '@/lib/portal-api'

/**
 * O início do Portal.
 *
 * A fatia 1 entregou a **porta**, e esta tela era a prova de que ela abre. Com a fatia
 * 2 ela vira o que devia ser: o desvio para os pets, que é o que o tutor veio buscar.
 *
 * O que ainda não existe continua anunciado. Quem entrou e não encontrou o que
 * procurava conclui que o acesso não funcionou — dizer "chega em breve" custa duas
 * linhas e evita uma ligação, que é justamente o que o módulo promete eliminar.
 */

export const dynamic = 'force-dynamic'

/**
 * O que ainda não existe continua anunciado, e a lista **encolhe** a cada fatia.
 *
 * Item que ganhou tela sai daqui no mesmo commit em que a tela nasce — senão o Portal
 * promete em uma seção o que já entrega na outra, e é a promessa que se lê primeiro.
 */
const EM_BREVE = [
  'Pedir o leva-e-traz junto com o horário',
  'Rever as mensagens que o estabelecimento mandou',
]

export default async function PortalInicioPage() {
  let context
  try {
    context = await readPortalContext()
  } catch (error) {
    // Vínculo revogado ou sessão que deixou de valer: volta para a porta, em vez de
    // mostrar uma tela de erro a quem só precisa entrar de novo.
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    throw error
  }

  /**
   * **Negativo é dívida** (RN-02 do MOD-LEDGER), e esta tela já leu ao contrário: até a
   * fatia 4 ela comparava `saldo > 0` com "Em aberto" e dizia "Sem pendências" a quem
   * devia. As duas funções vêm do pacote compartilhado justamente para que a conversão
   * não seja refeita, e reinvertida, em cada tela nova.
   */
  const deve = portalOwesCents(context.tutor.balanceCents)
  const credito = portalCreditCents(context.tutor.balanceCents)

  return (
    <PortalFrame
      tenantName={context.tenant.name}
      titulo={`Olá, ${primeiroNome(context.tutor.name)}`}
      descricao="Seu acesso está ativo."
    >
      <Card>
        <div className="flex flex-col gap-1">
          <DataRow label="Pets cadastrados">{context.tutor.petsCount}</DataRow>
          <DataRow label={deve > 0 ? 'Em aberto' : 'Sua conta'}>
            {deve > 0
              ? formatBRL(deve)
              : credito > 0
                ? `${formatBRL(credito)} de crédito`
                : 'Sem pendências'}
          </DataRow>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {/*
            Marcar horário é o botão principal, e "ver meus pets" desce a fantasma.
            É o que a pessoa vem fazer: consultar a ficha é o que se faz uma vez, marcar
            banho é o que se faz todo mês.
          */}
          {context.features.onlineBookingEnabled && (
            <Link href="/portal/agendar" className="btn btn-primary w-full">
              Marcar horário
            </Link>
          )}
          <Link href="/portal/agendamentos" className="btn btn-ghost w-full">
            Meus agendamentos
          </Link>
          <Link href="/portal/pets" className="btn btn-ghost w-full">
            Meus pets
          </Link>
          <Link href="/portal/financeiro" className="btn btn-ghost w-full">
            Minha conta
          </Link>
        </div>
      </Card>

      <Card>
        <p className="section-eyebrow">Em breve por aqui</p>
        <ul className="mt-3 flex flex-col gap-2 text-muted">
          {EM_BREVE.map((item) => (
            <li key={item} className="text-sm">
              {item}
            </li>
          ))}
        </ul>
      </Card>
    </PortalFrame>
  )
}

function primeiroNome(nome: string): string {
  return nome.split(' ')[0] ?? nome
}
