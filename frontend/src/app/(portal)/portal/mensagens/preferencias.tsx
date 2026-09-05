'use client'

import { useState, useTransition } from 'react'
import type { PortalChannel, PortalPreferencesResponse } from '@petshop/shared-types'
import { Card, Choice } from '@/components/ui'
import { salvarPreferencia } from './actions'

/**
 * As preferências de comunicação (AC-03 de MOD-PORTAL-10).
 *
 * **Salva no clique, sem botão de confirmar.** Um "salvar" no rodapé de dois
 * interruptores é uma etapa a mais para a pessoa que está incomodada o bastante para
 * abrir esta tela — e é a etapa em que se desiste no meio, achando ter desligado o que
 * continua ligado.
 *
 * O estado exibido é sempre o que o servidor devolveu, nunca o que a tela supôs: uma
 * preferência que parece salva e não está é o defeito mais caro daqui.
 */
export function Preferencias({ inicial }: { inicial: PortalPreferencesResponse }) {
  const [preferencias, setPreferencias] = useState(inicial)
  const [erro, setErro] = useState<string | null>(null)
  const [salvandoCanal, setSalvandoCanal] = useState<PortalChannel | null>(null)
  const [, startTransition] = useTransition()

  const visiveis = preferencias.marketing.filter((item) =>
    preferencias.availableChannels.includes(item.channel),
  )

  function alternar(channel: PortalChannel, granted: boolean) {
    setErro(null)
    setSalvandoCanal(channel)
    startTransition(async () => {
      const resultado = await salvarPreferencia({ channel, granted })
      setSalvandoCanal(null)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setPreferencias({
        marketing: resultado.marketing,
        availableChannels: resultado.availableChannels,
      })
    })
  }

  /**
   * Sem canal cadastrado não há o que decidir.
   *
   * Acontece com a ficha antiga que só tem telefone fixo: mostrar dois interruptores
   * mortos faria o tutor desligar o que nunca esteve ligado e concluir que o sistema o
   * ignora quando as promoções continuassem não chegando.
   */
  if (visiveis.length === 0) return null

  return (
    <Card tone="soft">
      <p className="section-eyebrow">Novidades e promoções</p>
      <p className="hint mt-2">
        Escolha por onde o estabelecimento pode falar de campanhas, pacotes e datas
        especiais.
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {visiveis.map((item) => (
          <Choice
            key={item.channel}
            label={item.channel === 'WHATSAPP' ? 'Receber por WhatsApp' : 'Receber por e-mail'}
            description={desde(item.granted, item.since)}
            checked={item.granted}
            disabled={salvandoCanal !== null}
            onChange={(valor) => alternar(item.channel, valor)}
          />
        ))}
      </div>

      {erro && (
        <p className="text-danger mt-3 text-sm" role="alert">
          {erro}
        </p>
      )}

      {/*
        A frase que impede a pergunta seguinte. Quem desliga promoções teme perder o
        aviso de que a van está a caminho — e ela não depende de opt-in, porque é
        execução do serviço que a pessoa contratou.
      */}
      <p className="hint mt-4">
        Confirmações de horário, lembretes do seu agendamento e avisos do leva-e-traz
        continuam chegando: eles fazem parte do atendimento e não são promoções.
      </p>
    </Card>
  )
}

/**
 * "Desligado em 3 de setembro" responde sozinho metade das reclamações de "continuo
 * recebendo" — e a data existe porque a tabela é append-only e guarda cada transição.
 */
function desde(granted: boolean, since: string | null): string | undefined {
  if (!since) return undefined
  const data = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long' }).format(
    new Date(since),
  )
  return granted ? `Autorizado em ${data}` : `Desligado em ${data}`
}
