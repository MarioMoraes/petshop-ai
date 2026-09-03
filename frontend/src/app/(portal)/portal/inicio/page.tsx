import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatBRL } from '@petshop/shared-types'
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

const EM_BREVE = [
  'Marcar horário e pedir o leva-e-traz',
  'Acompanhar a sua conta e baixar recibos',
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

  const saldo = context.tutor.balanceCents

  return (
    <PortalFrame
      tenantName={context.tenant.name}
      titulo={`Olá, ${primeiroNome(context.tutor.name)}`}
      descricao="Seu acesso está ativo."
    >
      <Card>
        <div className="flex flex-col gap-1">
          <DataRow label="Pets cadastrados">{context.tutor.petsCount}</DataRow>
          <DataRow label={saldo > 0 ? 'Em aberto' : 'Sua conta'}>
            {saldo > 0 ? formatBRL(saldo) : 'Sem pendências'}
          </DataRow>
        </div>

        <Link href="/portal/pets" className="btn btn-primary mt-4 w-full">
          Ver meus pets
        </Link>
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
