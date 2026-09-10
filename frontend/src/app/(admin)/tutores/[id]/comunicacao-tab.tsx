'use client'

import { useState, useTransition } from 'react'
import type { PaginatedMessages } from '@petshop/shared-types'
import { Button, FormError } from '@/components/ui'
import { loadTutorMessagesAction } from '@/app/(admin)/crm/actions'
import { MessageList } from '@/app/(admin)/crm/message-list'

/**
 * O histórico de comunicação do tutor (MOD-CRM-10), dentro da ficha.
 *
 * Fica aqui pela mesma razão que a conta corrente: é aqui que a pergunta nasce. O
 * atendente atende o telefone, abre o cadastro e precisa saber se o lembrete de ontem
 * chegou — procurar o mesmo nome de novo num painel separado seria o caminho longo
 * para a mesma resposta.
 *
 * A lista é a **mesma** do painel de entregas, e não uma versão enxuta: quem lê aqui
 * também precisa do motivo do bloqueio e do erro do provedor, porque é daqui que sai
 * a frase "não chegou porque o e-mail está errado no cadastro".
 *
 * A paginação passa por ação de servidor em vez de URL porque isto é uma aba: mandar
 * a página para a query string devolveria o atendente à aba "Dados" a cada clique.
 */

interface Props {
  tutorId: string
  initial: PaginatedMessages
  canSend: boolean
}

export function ComunicacaoTab({ tutorId, initial, canSend }: Props) {
  const [page, setPage] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const totalPages = Math.max(1, Math.ceil(page.total / page.limit))

  function go(next: number) {
    setError(null)
    startTransition(async () => {
      const result = await loadTutorMessagesAction(tutorId, next)
      if (result.ok) setPage(result.data)
      else setError(result.message)
    })
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <MessageList
        messages={page.data}
        canSend={canSend}
        showTutor={false}
        empty={{
          title: 'Nenhuma mensagem ainda',
          description:
            'Quando este tutor tiver um agendamento, a confirmação e o lembrete aparecem aqui — com o que aconteceu com cada um.',
        }}
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            busy={pending}
            disabled={page.page <= 1}
            onClick={() => go(page.page - 1)}
            busyLabel="Carregando…"
          >
            Anterior
          </Button>
          <p className="hint">
            Página {page.page} de {totalPages}
          </p>
          <Button
            type="button"
            variant="ghost"
            busy={pending}
            disabled={page.page >= totalPages}
            onClick={() => go(page.page + 1)}
            busyLabel="Carregando…"
          >
            Próxima
          </Button>
        </div>
      )}
    </div>
  )
}
