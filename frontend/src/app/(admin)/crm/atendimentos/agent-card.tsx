'use client'

import { useState, useTransition } from 'react'
import { formatBRL, type AgentSettings } from '@petshop/shared-types'
import { Alert, Button, Card, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, BellIcon } from '@/components/icons'
import { salvarConfiguracaoAction } from './actions'

/**
 * O interruptor do atendimento automático (MOD-AI-07).
 *
 * Fica **em cima da fila**, e não numa aba de configuração: é aqui que o efeito de ligar
 * ou desligar aparece. Com ele ligado, a fila só recebe o que o agente não resolveu; com
 * ele desligado, recebe tudo — e a diferença entre uma fila vazia porque o robô deu conta
 * e uma fila vazia porque ninguém escreveu é a primeira coisa que quem abre esta tela
 * precisa saber.
 *
 * `Card tone="soft"`, como manda a regra 1 do design: é ficha com campos, não conteúdo.
 */

interface Props {
  settings: AgentSettings
  /** `crm:configure`. Sem ela o cartão vira uma linha de estado, sem controles. */
  podeConfigurar: boolean
}

export function AgentCard({ settings, podeConfigurar }: Props) {
  const [atual, setAtual] = useState(settings)
  const [opensAt, setOpensAt] = useState(settings.opensAt)
  const [closesAt, setClosesAt] = useState(settings.closesAt)
  const [teto, setTeto] = useState(String(Math.round(settings.monthlyCapCents / 100)))
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, startSave] = useTransition()

  function salvar(patch: Parameters<typeof salvarConfiguracaoAction>[0]) {
    setErro(null)
    startSave(async () => {
      const resultado = await salvarConfiguracaoAction(patch)
      if (resultado.ok) setAtual(resultado.data)
      else setErro(resultado.message)
    })
  }

  const gasto = formatBRL(atual.spentCents)
  const teto_ = formatBRL(atual.monthlyCapCents)

  if (!podeConfigurar) {
    return (
      <Card tone="soft">
        <SectionHead icon={<BellIcon />} tone="icon-brand" title="Atendimento automático" />
        <p className="text-sm text-muted">
          {atual.enabled
            ? `Ligado, das ${atual.opensAt} às ${atual.closesAt}. O que ele não resolve aparece aqui na fila.`
            : 'Desligado. Toda mensagem que chega vem para esta fila.'}
        </p>
      </Card>
    )
  }

  return (
    <Card tone="soft">
      <SectionHead
        icon={<BellIcon />}
        tone="icon-brand"
        title="Atendimento automático"
        description="Responde sobre agendamentos, serviços e situação da conta. Nunca marca nem cancela nada — isso ele passa para a equipe."
      />

      {erro && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="Não foi possível salvar">
          {erro}
        </Alert>
      )}

      {!atual.canEnable && (
        <Alert
          tone="accent"
          role="status"
          icon={<AlertTriangleIcon />}
          title="O envio de mensagens está desligado"
        >
          Sem ele o agente leria as mensagens e não conseguiria responder. Ligue o envio na
          configuração do relacionamento antes.
        </Alert>
      )}

      <label className="check mt-4">
        <input
          type="checkbox"
          checked={atual.enabled}
          disabled={salvando || !atual.canEnable}
          onChange={(event) => salvar({ enabled: event.target.checked })}
        />
        <span>
          <span className="font-medium">Responder automaticamente</span>
          <span className="hint block">
            A primeira resposta de cada conversa avisa ao cliente que ele fala com um atendimento
            automático.
          </span>
        </span>
      </label>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="hint">Começa às</span>
          <input
            type="time"
            className="field mt-1"
            value={opensAt}
            disabled={salvando}
            onChange={(event) => setOpensAt(event.target.value)}
            onBlur={() => opensAt !== atual.opensAt && salvar({ opensAt })}
          />
        </label>

        <label className="block">
          <span className="hint">Até às</span>
          <input
            type="time"
            className="field mt-1"
            value={closesAt}
            disabled={salvando}
            onChange={(event) => setClosesAt(event.target.value)}
            onBlur={() => closesAt !== atual.closesAt && salvar({ closesAt })}
          />
        </label>

        <label className="block">
          <span className="hint">Teto do mês (R$)</span>
          <input
            type="number"
            min={0}
            step={10}
            className="field mt-1"
            value={teto}
            disabled={salvando}
            onChange={(event) => setTeto(event.target.value)}
            onBlur={() => {
              const cents = Math.round(Number(teto) * 100)
              if (Number.isFinite(cents) && cents !== atual.monthlyCapCents) {
                salvar({ monthlyCapCents: cents })
              }
            }}
          />
        </label>
      </div>

      {/* O número que decide se o módulo se paga, e o único que a tela mostra em dinheiro. */}
      <p className="hint mt-4">
        Gasto deste mês: {gasto} de {teto_}. Atingido o teto, tudo passa a vir para a fila.
      </p>

      {salvando && (
        <p className="hint mt-2" role="status">
          Salvando…
        </p>
      )}

      <div className="mt-4 flex justify-end">
        <Button
          variant="ghost"
          busy={salvando}
          busyLabel="Salvando"
          onClick={() =>
            salvar({
              opensAt,
              closesAt,
              monthlyCapCents: Math.round(Number(teto) * 100),
            })
          }
        >
          Salvar horário e teto
        </Button>
      </div>
    </Card>
  )
}
