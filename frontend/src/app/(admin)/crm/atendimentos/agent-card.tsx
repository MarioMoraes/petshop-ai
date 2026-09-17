'use client'

import { useState, useTransition } from 'react'
import {
  AGENT_PERSONA_NAME_MAX,
  AGENT_TONES,
  AGENT_TONE_LABELS,
  formatBRL,
  type AgentSettings,
} from '@petshop/shared-types'
import { Alert, Button, Card, Field, SectionHead, Segmented } from '@/components/ui'
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
 *
 * **O cartão tem três faixas, e a ordem é a da pergunta que se faz ao chegar:** está
 * ligado? quanto já custou? em que horário e até quanto pode gastar? A primeira é um
 * cabeçalho com o botão de estado à direita — o mesmo desenho do envio automático em
 * `crm/configuracoes`, porque é a mesma frase dita sobre outro motor. A segunda é a régua
 * do mês. A terceira são os campos.
 */

interface Props {
  /**
   * O plano que libera nome e tom próprios, quando o do estabelecimento não libera.
   * `null` é "está no plano". Sem ele os dois controles ficam travados no padrão — é o
   * que o backend já responde, porque a configuração efetiva ignora a persona gravada.
   */
  personaNoPlano: string | null
  settings: AgentSettings
  /** `crm:configure`. Sem ela o cartão vira uma linha de estado, sem controles. */
  podeConfigurar: boolean
}

/**
 * A régua do gasto do mês.
 *
 * **O número que decide se o módulo se paga**, e o único que a tela mostra em dinheiro.
 * Era uma frase solta no pé do cartão, onde um teto quase estourado lia igualzinho a um
 * teto intocado. Barra reusa `.meter` da ocupação da agenda — mesma peça, mesma física,
 * e o `meter-fill-full` acende no acento a partir de 80%, que é onde ainda dá tempo de
 * subir o teto antes de a fila começar a encher sozinha.
 */
function ReguaDoMes({ gastoCents, tetoCents }: { gastoCents: number; tetoCents: number }) {
  const pct = tetoCents > 0 ? (gastoCents / tetoCents) * 100 : 0
  const estourou = tetoCents > 0 && gastoCents >= tetoCents

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="section-eyebrow">Gasto deste mês</span>
        <span className="text-sm tabular-nums">
          <span className="font-semibold">{formatBRL(gastoCents)}</span>
          <span className="text-subtle"> de {formatBRL(tetoCents)}</span>
        </span>
      </div>

      <div className="meter mt-2">
        <div
          className={`meter-fill ${pct >= 80 ? 'meter-fill-full' : ''}`}
          style={{ width: `${Math.min(100, Math.max(pct > 0 ? 2 : 0, pct))}%` }}
        />
      </div>

      <p className="hint mt-2">
        {estourou
          ? 'O teto do mês foi atingido. Tudo o que chega está vindo para a fila.'
          : 'Atingido o teto, tudo passa a vir para a fila.'}
      </p>
    </div>
  )
}

export function AgentCard({ settings, podeConfigurar, personaNoPlano }: Props) {
  const [atual, setAtual] = useState(settings)
  const [opensAt, setOpensAt] = useState(settings.opensAt)
  const [closesAt, setClosesAt] = useState(settings.closesAt)
  const [teto, setTeto] = useState(String(Math.round(settings.monthlyCapCents / 100)))
  const [persona, setPersona] = useState(settings.personaName ?? '')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, startSave] = useTransition()
  /** Separado de `salvando` para o anel girar só no botão que foi clicado. */
  const [alternando, startToggle] = useTransition()

  function salvar(patch: Parameters<typeof salvarConfiguracaoAction>[0], toggle = false) {
    setErro(null)
    const run = async () => {
      const resultado = await salvarConfiguracaoAction(patch)
      if (resultado.ok) setAtual(resultado.data)
      else setErro(resultado.message)
    }
    if (toggle) startToggle(run)
    else startSave(run)
  }

  /**
   * A descrição diz o que o agente faz **de verdade** desde o MOD-AI-04.
   *
   * Até a fatia 2 ele só lia, e o texto prometia que nada seria marcado nem cancelado.
   * Passou a marcar — em duas etapas, com a proposta que o cliente confirma —, e uma
   * promessa vencida no cartão de configuração é pior que nenhuma: quem lê decide com ela
   * se liga o robô.
   */
  const descricao = atual.enabled
    ? `Responde no WhatsApp das ${atual.opensAt} às ${atual.closesAt}. Marca, cancela e remarca só depois de o cliente confirmar a proposta.`
    : 'Desligado. Toda mensagem que chega vai direto para a fila, sem passar pelo agente.'

  if (!podeConfigurar) {
    return (
      <Card tone="soft">
        <SectionHead
          icon={<BellIcon />}
          tone="icon-brand"
          eyebrow="Atendimento automático"
          title={atual.enabled ? 'O agente está respondendo' : 'O agente está desligado'}
          description={descricao}
        />
        <ReguaDoMes gastoCents={atual.spentCents} tetoCents={atual.monthlyCapCents} />
      </Card>
    )
  }

  return (
    /**
     * A borda de acento quando está desligado é a mesma do envio automático: o estado que
     * **impede o produto de funcionar** é o que ganha aresta, e não o normal.
     */
    <Card tone="soft" className={atual.enabled ? '' : 'border-accent/40'}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1">
          <SectionHead
            icon={<BellIcon />}
            tone="icon-brand"
            eyebrow="Atendimento automático"
            title={atual.enabled ? 'O agente está respondendo' : 'O agente está desligado'}
            description={descricao}
          />
        </div>

        <Button
          busy={alternando}
          busyLabel="Salvando"
          /*
           * Sem motor de mensagens **não se liga**, mas sempre se desliga: travar os dois
           * sentidos deixaria preso no ar um agente que já não consegue responder.
           */
          disabled={salvando || (!atual.canEnable && !atual.enabled)}
          onClick={() => salvar({ enabled: !atual.enabled }, true)}
        >
          {atual.enabled ? 'Desligar' : 'Ligar'}
        </Button>
      </div>

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

      <p className="hint mt-4">
        A primeira resposta de cada conversa avisa ao cliente que ele fala com um atendimento
        automático. Esse aviso não se desliga.
      </p>

      <ReguaDoMes gastoCents={atual.spentCents} tetoCents={atual.monthlyCapCents} />

      {/*
       * Como ele fala.
       *
       * Fica **antes** da janela e do teto de propósito: quem abre este cartão depois de
       * ligar o agente quer saber como ele soa para o cliente, e não quanto ele custou.
       * Os dois controles gravam sozinhos — o nome ao sair do campo, o tom ao ser
       * escolhido —, que é o mesmo idioma do resto do cartão e evita um terceiro botão.
       */}
      <div className="mt-6 border-t border-line pt-4">
        <p className="section-eyebrow">Como ele fala</p>
        {personaNoPlano && (
          <p className="hint mt-1">
            Nome e tom próprios estão no plano {personaNoPlano}. Até lá, o agente fala no tom padrão
            e se apresenta sem nome.
          </p>
        )}

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Nome do agente (opcional)" htmlFor="agent-persona">
            <input
              id="agent-persona"
              className="field"
              maxLength={AGENT_PERSONA_NAME_MAX}
              placeholder="Lia"
              value={persona}
              disabled={salvando || personaNoPlano !== null}
              onChange={(event) => setPersona(event.target.value)}
              onBlur={() => {
                const limpo = persona.trim()
                // `null` apaga, e é o que faz o campo em branco voltar ao padrão em vez
                // de gravar um nome vazio.
                if (limpo !== (atual.personaName ?? '')) {
                  salvar({ personaName: limpo === '' ? null : limpo })
                }
              }}
            />
          </Field>

          {/*
            O `Segmented` fica fora de um `Field`: ele é um grupo de botões, não um campo,
            e um `<label htmlFor>` apontando para nada quebra o leitor de tela. O rótulo
            visível é `.label`, e quem anuncia o grupo é o `ariaLabel`.
          */}
          <div>
            <p className="label">Tom da conversa</p>
            <div className="mt-2">
              <Segmented
                ariaLabel="Tom da conversa"
                disabled={salvando || personaNoPlano !== null}
                value={atual.tone}
                options={AGENT_TONES.map((tone) => ({
                  value: tone,
                  label: AGENT_TONE_LABELS[tone].label,
                }))}
                onChange={(tone) => salvar({ tone })}
              />
            </div>
          </div>
        </div>

        <p className="hint mt-3">{AGENT_TONE_LABELS[atual.tone].hint}</p>

        <p className="hint mt-2">
          Com nome, ele se apresenta como “Sou a Lia, do atendimento automático do{' '}
          {'<nome da loja>'}”. Sem nome, como “Sou o atendimento automático do {'<nome da loja>'}”.
        </p>
      </div>

      <div className="mt-6 border-t border-line pt-4">
        <p className="section-eyebrow">Janela e teto</p>

        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Field label="Começa às" htmlFor="agent-opens-at">
            <input
              id="agent-opens-at"
              type="time"
              className="field"
              value={opensAt}
              disabled={salvando}
              onChange={(event) => setOpensAt(event.target.value)}
              onBlur={() => opensAt !== atual.opensAt && salvar({ opensAt })}
            />
          </Field>

          <Field label="Até às" htmlFor="agent-closes-at">
            <input
              id="agent-closes-at"
              type="time"
              className="field"
              value={closesAt}
              disabled={salvando}
              onChange={(event) => setClosesAt(event.target.value)}
              onBlur={() => closesAt !== atual.closesAt && salvar({ closesAt })}
            />
          </Field>

          <Field label="Teto do mês (R$)" htmlFor="agent-monthly-cap">
            <input
              id="agent-monthly-cap"
              type="number"
              min={0}
              step={10}
              className="field"
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
          </Field>
        </div>

        {/*
         * A linha de ação fica **dentro** do cartão, e não em `<FormActions>`: a regra 9
         * do design reserva a barra grudada para o formulário de página inteira, e aqui
         * ela grudaria no cartão em vez de na tela.
         */}
        <div className="mt-5 flex items-center justify-end gap-3">
          <Button
            busy={salvando}
            busyLabel="Salvando"
            disabled={alternando}
            onClick={() =>
              salvar({
                opensAt,
                closesAt,
                monthlyCapCents: Math.round(Number(teto) * 100),
              })
            }
          >
            Salvar janela e teto
          </Button>
        </div>
      </div>
    </Card>
  )
}
