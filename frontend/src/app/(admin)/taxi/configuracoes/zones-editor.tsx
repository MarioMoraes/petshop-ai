'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { resolveZipZone, type TaxiZoneResponse } from '@petshop/shared-types'
import { Button, Card, Field, FormError } from '@/components/ui'
import { createZoneAction, deleteZoneAction, updateZoneAction } from '../actions'

/**
 * Zonas de preço (MOD-TAXI-06).
 *
 * A tela existia como **lista**, e só. O efeito prático apareceu no primeiro pedido de
 * corrida de verdade: com `blockOutsideZones` ligado e nenhuma zona cadastrada, todo
 * CEP era recusado — e não havia, pela interface, como cadastrar a primeira zona. O
 * admin ficava preso entre um interruptor que recusa tudo e uma lista que não escreve.
 *
 * Duas escolhas de tela:
 *
 * **O testador de CEP fica no topo, não no fim.** "Este CEP cairia em qual zona?" é a
 * pergunta que se faz *antes* de cadastrar, para descobrir se falta zona ou se falta
 * prefixo numa que já existe. `resolveZipZone` vem de `shared-types` de propósito: é a
 * mesma função que o serviço usa para cobrar, e não uma segunda leitura da regra.
 *
 * **Desativar é mais visível que excluir.** Zona com corrida não se exclui (o preço
 * ficou congelado nela, RN-07), e o serviço recusa com ERR_TAXI_013. Quem quer parar
 * de atender um bairro quer desativar — excluir é para a zona cadastrada errado, há
 * cinco minutos.
 */

interface Props {
  zones: TaxiZoneResponse[]
  /** Preço de quem não cai em zona nenhuma — e se esse caso é recusado. */
  defaultPriceCents: number
  blockOutsideZones: boolean
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/** "011, 0123" → ["011","0123"]. Aceita vírgula, espaço e quebra de linha. */
function parsePrefixes(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((piece) => piece.replace(/\D/g, ''))
    .filter((piece) => piece.length > 0)
}

const NOVA = { name: '', prefixes: '', price: '' }

export function ZonesEditor({ zones, defaultPriceCents, blockOutsideZones }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [erro, setErro] = useState<string | null>(null)

  const [nova, setNova] = useState(NOVA)
  const [criando, setCriando] = useState(false)
  const [editando, setEditando] = useState<string | null>(null)
  const [rascunho, setRascunho] = useState(NOVA)
  const [teste, setTeste] = useState('')

  function run(action: () => Promise<{ ok: boolean; message?: string }>, aoFim?: () => void) {
    setErro(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        setErro(result.message ?? 'Não foi possível concluir')
        return
      }
      aoFim?.()
      router.refresh()
    })
  }

  function precoEmCentavos(raw: string): number | null {
    const valor = Number(raw.replace(',', '.'))
    if (Number.isNaN(valor) || valor < 0) return null
    return Math.round(valor * 100)
  }

  function criar() {
    const prefixes = parsePrefixes(nova.prefixes)
    const priceCents = precoEmCentavos(nova.price)
    if (prefixes.length === 0) {
      setErro('Informe ao menos um prefixo de CEP')
      return
    }
    if (priceCents === null) {
      setErro('Preço inválido — use reais, como 25,00')
      return
    }
    run(
      () => createZoneAction({ name: nova.name, zipPrefixes: prefixes, priceCents, active: true }),
      () => {
        setNova(NOVA)
        setCriando(false)
      },
    )
  }

  function salvarEdicao(zone: TaxiZoneResponse) {
    const prefixes = parsePrefixes(rascunho.prefixes)
    const priceCents = precoEmCentavos(rascunho.price)
    if (prefixes.length === 0) {
      setErro('Informe ao menos um prefixo de CEP')
      return
    }
    if (priceCents === null) {
      setErro('Preço inválido — use reais, como 25,00')
      return
    }
    run(
      () =>
        updateZoneAction(zone.id, {
          name: rascunho.name,
          zipPrefixes: prefixes,
          priceCents,
        }),
      () => setEditando(null),
    )
  }

  // O testador usa a MESMA função que o serviço usa para cobrar (RN-17: prefixo mais
  // longo vence), e só olha zonas ativas, como o `resolvePrice` faz.
  const digitos = teste.replace(/\D/g, '')
  const zonaDoTeste =
    digitos.length === 8
      ? resolveZipZone(
          digitos,
          zones.filter((zone) => zone.active),
        )
      : null

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium text-fg">Zonas de preço</h2>
        {!criando && (
          <Button
            type="button"
            variant="ghost"
            className="h-9"
            disabled={pending}
            onClick={() => setCriando(true)}
          >
            Nova zona
          </Button>
        )}
      </div>

      <FormError message={erro} />

      {/* ─── O aviso que faltava ────────────────────────────────────────── */}

      {zones.length === 0 && blockOutsideZones && (
        <div className="rounded-2xl bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          <strong>Nenhuma corrida vai ser aceita.</strong> Não há zona cadastrada e &quot;Recusar
          CEP fora das zonas&quot; está ligado — toda tentativa de pedir Taxi Dog termina em
          &quot;CEP fora das zonas atendidas&quot;. Cadastre uma zona abaixo, ou desligue a recusa
          para usar o preço padrão de {money(defaultPriceCents)}.
        </div>
      )}

      {zones.length === 0 && !blockOutsideZones && (
        <p className="text-sm text-subtle">
          Nenhuma zona. Todas as corridas usam o preço padrão de {money(defaultPriceCents)}.
        </p>
      )}

      {/* ─── Testar um CEP ──────────────────────────────────────────────── */}

      {zones.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Testar um CEP" htmlFor="teste-cep">
            <input
              id="teste-cep"
              className="field w-40"
              inputMode="numeric"
              placeholder="37705220"
              value={teste}
              onChange={(event) => setTeste(event.target.value)}
            />
          </Field>
          {digitos.length === 8 && (
            <p className={`pb-2 text-sm ${zonaDoTeste ? 'text-fg' : 'text-danger'}`}>
              {zonaDoTeste
                ? `Cai na zona "${zonaDoTeste.name}" — ${money(zonaDoTeste.priceCents)}.`
                : blockOutsideZones
                  ? 'Fora de todas as zonas: a corrida seria recusada.'
                  : `Fora de todas as zonas: usaria o preço padrão de ${money(defaultPriceCents)}.`}
            </p>
          )}
        </div>
      )}

      {/* ─── A lista ────────────────────────────────────────────────────── */}

      {zones.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {zones.map((zone) =>
            editando === zone.id ? (
              <li key={zone.id} className="space-y-2 py-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_7rem]">
                  <Field label="Nome" htmlFor={`nome-${zone.id}`}>
                    <input
                      id={`nome-${zone.id}`}
                      className="field"
                      value={rascunho.name}
                      onChange={(event) => setRascunho((c) => ({ ...c, name: event.target.value }))}
                    />
                  </Field>
                  <Field
                    label="Prefixos de CEP"
                    htmlFor={`pref-${zone.id}`}
                    hint="2 a 8 dígitos, separados por vírgula"
                  >
                    <input
                      id={`pref-${zone.id}`}
                      className="field"
                      value={rascunho.prefixes}
                      onChange={(event) =>
                        setRascunho((c) => ({ ...c, prefixes: event.target.value }))
                      }
                    />
                  </Field>
                  <Field label="Preço (R$)" htmlFor={`preco-${zone.id}`}>
                    <input
                      id={`preco-${zone.id}`}
                      className="field"
                      inputMode="decimal"
                      value={rascunho.price}
                      onChange={(event) =>
                        setRascunho((c) => ({ ...c, price: event.target.value }))
                      }
                    />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    className="h-9"
                    busy={pending}
                    onClick={() => salvarEdicao(zone)}
                    busyLabel="Salvando…"
                  >
                    Salvar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9"
                    disabled={pending}
                    onClick={() => setEditando(null)}
                  >
                    Cancelar
                  </Button>
                </div>
              </li>
            ) : (
              <li key={zone.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <span className={zone.active ? 'text-fg' : 'text-subtle line-through'}>
                  {zone.name}
                  <span className="ml-2 text-subtle">{zone.zipPrefixes.join(', ')}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-subtle">{money(zone.priceCents)}</span>
                  <button
                    type="button"
                    className="text-sm underline decoration-line hover:decoration-fg"
                    disabled={pending}
                    onClick={() => {
                      setEditando(zone.id)
                      setRascunho({
                        name: zone.name,
                        prefixes: zone.zipPrefixes.join(', '),
                        price: (zone.priceCents / 100).toFixed(2).replace('.', ','),
                      })
                    }}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="text-sm underline decoration-line hover:decoration-fg"
                    disabled={pending}
                    onClick={() => run(() => updateZoneAction(zone.id, { active: !zone.active }))}
                  >
                    {zone.active ? 'Desativar' : 'Reativar'}
                  </button>
                  <button
                    type="button"
                    className="text-sm text-danger underline decoration-line"
                    disabled={pending}
                    onClick={() => run(() => deleteZoneAction(zone.id))}
                  >
                    Excluir
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}

      {/* ─── Nova zona ──────────────────────────────────────────────────── */}

      {criando && (
        <div className="space-y-2 rounded-xl border border-line px-3 py-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_7rem]">
            <Field label="Nome" htmlFor="nova-nome">
              <input
                id="nova-nome"
                className="field"
                placeholder="Centro"
                value={nova.name}
                onChange={(event) => setNova((c) => ({ ...c, name: event.target.value }))}
              />
            </Field>
            <Field
              label="Prefixos de CEP"
              htmlFor="nova-pref"
              hint="2 a 8 dígitos. 377 cobre todos os CEPs que começam por 377."
            >
              <input
                id="nova-pref"
                className="field"
                placeholder="377, 37705"
                value={nova.prefixes}
                onChange={(event) => setNova((c) => ({ ...c, prefixes: event.target.value }))}
              />
            </Field>
            <Field label="Preço (R$)" htmlFor="nova-preco">
              <input
                id="nova-preco"
                className="field"
                inputMode="decimal"
                placeholder="25,00"
                value={nova.price}
                onChange={(event) => setNova((c) => ({ ...c, price: event.target.value }))}
              />
            </Field>
          </div>
          <p className="hint">
            O prefixo mais longo vence: cadastrar 377 e depois 37705 faz o segundo mandar no bairro
            que ele descreve, sem apagar o primeiro.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="h-9"
              busy={pending}
              onClick={criar}
              busyLabel="Criando…"
            >
              Criar zona
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-9"
              disabled={pending}
              onClick={() => {
                setCriando(false)
                setNova(NOVA)
                setErro(null)
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
