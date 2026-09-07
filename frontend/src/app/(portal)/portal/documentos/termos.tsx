'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { TERM_KIND_LABELS, type PortalTerm } from '@petshop/shared-types'
import { Card } from '@/components/ui'
import { TextoDoTermo } from '@/components/term-text'
import { aceitarTermo } from './actions'

/**
 * Os termos, do lado de quem assina (AC-02 de MOD-DOC-07 e AC-01 de MOD-DOC-08).
 *
 * **O texto vem fechado e abre por toque.** São dois ou três documentos longos, e a tela
 * é lida no celular: despejá-los abertos empurraria a lista de documentos para fora da
 * primeira rolagem, que é o que a pessoa veio ver. Quem vai aceitar abre; quem já
 * aceitou raramente reabre.
 *
 * **O botão só existe quando falta aceitar.** Termo aceito na versão vigente vira uma
 * linha de estado, sem ação: oferecer "aceitar de novo" a quem já aceitou produziria um
 * 409 do servidor para um toque que a tela convidou a dar.
 */
export function Termos({ termos }: { termos: PortalTerm[] }) {
  if (termos.length === 0) return null

  return (
    <Card>
      <p className="section-eyebrow">Termos</p>
      <p className="hint mt-1">
        O que você aceitou, e quando. Aceitar registra a data, a hora e o aparelho — é
        essa a prova, e ela vale pelo texto que está aqui.
      </p>

      <div className="mt-3 flex flex-col">
        {termos.map((termo) => (
          <Termo key={termo.kind} termo={termo} />
        ))}
      </div>
    </Card>
  )
}

function Termo({ termo }: { termo: PortalTerm }) {
  const router = useRouter()
  const [aberto, setAberto] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, startTransition] = useTransition()

  function aceitar() {
    setErro(null)
    startTransition(async () => {
      const resultado = await aceitarTermo(termo.kind)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setAberto(false)
      router.refresh()
    })
  }

  return (
    <div className="border-line border-b py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{TERM_KIND_LABELS[termo.kind]}</p>
          <p className="hint mt-0.5">
            {termo.accepted
              ? `Aceito · versão ${termo.version}`
              : termo.acceptedVersion
                ? `Você aceitou a versão ${termo.acceptedVersion}; há uma nova`
                : 'Ainda não aceito'}
          </p>
        </div>

        <button
          type="button"
          className="text-accent-ink shrink-0 text-xs font-medium hover:underline"
          onClick={() => setAberto((atual) => !atual)}
        >
          {aberto ? 'Fechar' : 'Ler'}
        </button>
      </div>

      {aberto && (
        <div className="mt-3">
          <TextoDoTermo body={termo.body} />
        </div>
      )}

      {erro && (
        <p className="text-danger mt-3 text-sm" role="status">
          {erro}
        </p>
      )}

      {/*
        Fechado, o botão **abre o texto**; aberto, ele registra. Um "aceito" ao lado de
        um texto fechado colheria consentimento de quem não leu nada — e é justamente o
        texto que dá valor à prova.
      */}
      {!termo.accepted && (
        <button
          type="button"
          className="btn btn-primary mt-3 w-full"
          onClick={() => (aberto ? aceitar() : setAberto(true))}
          disabled={pendente}
        >
          {pendente ? 'Registrando…' : aberto ? 'Li e aceito' : 'Ler e aceitar'}
        </button>
      )}
    </div>
  )
}
