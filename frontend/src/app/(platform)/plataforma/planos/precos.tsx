'use client'

import { useState, useTransition } from 'react'
import {
  ANNUAL_DISCOUNT_PERCENT,
  formatBRL,
  formatCentsInput,
  parseBRLToCents,
  yearlyPriceOf,
  type PlanPriceAdminRow,
} from '@petshop/shared-types'
import { Alert, Badge, Button, Card, FormError, SectionHead } from '@/components/ui'
import { Modal } from '@/components/modal'
import { ReceiptIcon, WalletIcon } from '@/components/icons'
import { mudarPrecoAction, voltarPrecoPadraoAction } from '../actions'
import { dia } from '../formato'

/**
 * A tabela de preços do console.
 *
 * Cartão branco: é lista para ler, e a edição abre em `<Modal>`
 * (`docs/design-formularios.md`, regras 1 e 8). O tom é `icon-money`, o do financeiro em
 * todo o produto.
 *
 * **O aviso do grandfathering é a peça mais importante da tela**, e por isso ele não está
 * escondido no diálogo: quem abre isto quer saber, antes de mexer, o que acontece com os
 * clientes que já pagam. A resposta é "nada", e ela precisa estar visível sem clicar.
 *
 * O Enterprise aparece e não se edita. Some-lo levantaria a pergunta "cadê?"; mostrá-lo
 * como sob consulta responde antes de ela ser feita.
 */

export function Precos({ itens }: { itens: PlanPriceAdminRow[] }) {
  const [lista, setLista] = useState(itens)
  const [editando, setEditando] = useState<PlanPriceAdminRow | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  function substituir(linha: PlanPriceAdminRow) {
    setLista((atual) => atual.map((item) => (item.plan === linha.plan ? linha : item)))
  }

  return (
    <>
      <Alert
        tone="accent"
        role="status"
        icon={<ReceiptIcon />}
        title="Mudar o preço não reajusta quem já assina"
      >
        O valor fica congelado na assinatura, aqui e no Asaas. Quem contratou o Pro por R$ 299
        continua pagando R$ 299 até trocar de plano. Reajustar a base é outra operação — ela precisa
        de aviso prévio ao cliente e não existe nesta tela.
      </Alert>

      <Card>
        <SectionHead
          icon={<WalletIcon />}
          tone="icon-money"
          eyebrow="Comercial"
          title="Preço de tabela"
          description="É o que a landing anuncia e o que o checkout cobra de quem assina agora. A página de vendas acompanha sem novo deploy."
        />

        {erro && (
          <div className="mt-5">
            <FormError message={erro} />
          </div>
        )}

        <ul className="mt-6 flex flex-col">
          {lista.map((item) => {
            const sobConsulta = item.monthlyCents === null
            const mexido = item.updatedAt !== null

            return (
              <li
                key={item.plan}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {item.name}
                    {mexido && <Badge tone="accent">Preço próprio</Badge>}
                  </p>
                  <p className="hint mt-0.5">
                    {sobConsulta
                      ? 'Sob consulta — combinado com o cliente, fora da tabela'
                      : `${formatBRL(item.monthlyCents!)}/mês · ${formatBRL(item.yearlyCents!)}/ano`}
                  </p>
                  {mexido && (
                    <p className="hint mt-0.5">
                      mudado em {dia(item.updatedAt!)} · padrão do código{' '}
                      {formatBRL(item.defaultMonthlyCents!)}/mês
                    </p>
                  )}
                </div>

                {sobConsulta ? (
                  <span className="hint shrink-0">sem preço de tabela</span>
                ) : (
                  <span className="flex shrink-0 items-center gap-2">
                    {mexido && (
                      <VoltarAoPadrao item={item} onErro={setErro} onPronto={substituir} />
                    )}
                    <Button type="button" onClick={() => setEditando(item)}>
                      Mudar preço
                    </Button>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </Card>

      <Editar
        item={editando}
        onClose={() => setEditando(null)}
        onSalvo={(linha) => {
          substituir(linha)
          setEditando(null)
        }}
      />
    </>
  )
}

function VoltarAoPadrao({
  item,
  onErro,
  onPronto,
}: {
  item: PlanPriceAdminRow
  onErro: (mensagem: string | null) => void
  onPronto: (linha: PlanPriceAdminRow) => void
}) {
  const [confirmando, setConfirmando] = useState(false)
  const [pendente, startTransition] = useTransition()

  function voltar() {
    onErro(null)
    startTransition(async () => {
      const resultado = await voltarPrecoPadraoAction(item.plan)
      if (!resultado.ok) {
        onErro(resultado.message)
        setConfirmando(false)
        return
      }
      onPronto(resultado.data)
      setConfirmando(false)
    })
  }

  if (!confirmando) {
    return (
      <Button type="button" variant="ghost" onClick={() => setConfirmando(true)}>
        Voltar ao padrão
      </Button>
    )
  }

  return (
    <>
      <span className="hint">Voltar a {formatBRL(item.defaultMonthlyCents!)}/mês?</span>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setConfirmando(false)}
        disabled={pendente}
      >
        Não
      </Button>
      <Button type="button" onClick={voltar} busy={pendente} busyLabel="Voltando…">
        Voltar
      </Button>
    </>
  )
}

/**
 * O diálogo de preço.
 *
 * O anual vem preenchido com o desconto padrão assim que o mensal muda — é o valor que a
 * landing sabe anunciar —, mas continua editável: uma promoção de "dois meses grátis" é
 * outro número, e amarrar os dois obrigaria a mexer no código para fazê-la.
 */
function Editar({
  item,
  onClose,
  onSalvo,
}: {
  item: PlanPriceAdminRow | null
  onClose: () => void
  onSalvo: (linha: PlanPriceAdminRow) => void
}) {
  const [mensal, setMensal] = useState('')
  const [anual, setAnual] = useState('')
  const [motivo, setMotivo] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [erros, setErros] = useState<Record<string, string>>({})
  const [pendente, startTransition] = useTransition()
  const [aberto, setAberto] = useState<string | null>(null)

  // Trocar de linha reabre o diálogo com os valores daquela, sem um `useEffect` que
  // dispara a cada render: a chave é o próprio plano.
  if (item && aberto !== item.plan) {
    setAberto(item.plan)
    setMensal(formatCentsInput(item.monthlyCents ?? 0))
    setAnual(formatCentsInput(item.yearlyCents ?? 0))
    setMotivo('')
    setErro(null)
    setErros({})
  }

  function fechar() {
    setAberto(null)
    onClose()
  }

  /** Mexer no mensal repropõe o anual com o desconto padrão; o campo segue editável. */
  function mudarMensal(valor: string) {
    setMensal(valor)
    const cents = parseBRLToCents(valor)
    if (cents !== null && cents > 0) setAnual(formatCentsInput(yearlyPriceOf(cents)))
  }

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    if (!item) return
    setErro(null)
    setErros({})

    const monthlyCents = parseBRLToCents(mensal)
    const yearlyCents = parseBRLToCents(anual)
    if (monthlyCents === null || yearlyCents === null) {
      setErro('Informe os dois preços.')
      return
    }

    startTransition(async () => {
      const resultado = await mudarPrecoAction(item.plan, {
        monthlyCents,
        yearlyCents,
        reason: motivo,
      })
      if (!resultado.ok) {
        setErro(resultado.message)
        setErros(resultado.fieldErrors)
        return
      }
      onSalvo(resultado.data)
      setAberto(null)
    })
  }

  const mensalCents = parseBRLToCents(mensal)
  const anualCents = parseBRLToCents(anual)
  const desconto =
    mensalCents && anualCents && mensalCents > 0
      ? Math.round((1 - anualCents / (mensalCents * 12)) * 100)
      : null

  return (
    <Modal
      open={item !== null}
      onClose={fechar}
      icon={<WalletIcon />}
      tone="icon-money"
      eyebrow="Comercial"
      title={item ? `Preço do ${item.name}` : 'Preço'}
      subtitle="Vale para quem assinar a partir de agora. Nenhuma assinatura viva muda de valor."
      busy={pendente}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={fechar} disabled={pendente}>
            Cancelar
          </Button>
          <Button type="submit" form="preco" busy={pendente} busyLabel="Salvando…">
            Salvar preço
          </Button>
        </>
      }
    >
      <form id="preco" onSubmit={enviar} className="flex flex-col gap-4">
        <FormError message={erro} />

        <div>
          <label className="label" htmlFor="mensal">
            Mensalidade
          </label>
          <div className="field-wrap mt-1">
            <span className="field-lead">R$</span>
            <input
              id="mensal"
              className="field"
              inputMode="decimal"
              autoComplete="off"
              value={mensal}
              onChange={(event) => mudarMensal(event.target.value)}
            />
          </div>
          {erros.monthlyCents && <p className="mt-1.5 text-sm text-danger">{erros.monthlyCents}</p>}
        </div>

        <div>
          <label className="label" htmlFor="anual">
            Anuidade
          </label>
          <div className="field-wrap mt-1">
            <span className="field-lead">R$</span>
            <input
              id="anual"
              className="field"
              inputMode="decimal"
              autoComplete="off"
              value={anual}
              onChange={(event) => setAnual(event.target.value)}
            />
          </div>
          <p className="hint mt-1.5">
            {desconto === null
              ? `Proposto com ${ANNUAL_DISCOUNT_PERCENT}% de desconto sobre doze mensalidades.`
              : `${desconto}% de desconto sobre doze mensalidades.`}
          </p>
          {erros.yearlyCents && <p className="mt-1.5 text-sm text-danger">{erros.yearlyCents}</p>}
        </div>

        <div>
          <label className="label" htmlFor="motivo">
            Por que está mudando
          </label>
          <input
            id="motivo"
            className="field mt-1"
            autoComplete="off"
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
            placeholder="reajuste anual, alinhamento com a concorrência…"
          />
          <p className="hint mt-1.5">
            Fica na trilha da plataforma. É o que explica, meses depois, por que a tabela mudou
            naquele dia.
          </p>
          {erros.reason && <p className="mt-1.5 text-sm text-danger">{erros.reason}</p>}
        </div>
      </form>
    </Modal>
  )
}
