import Link from 'next/link'
import type { PlatformAuditEntry } from '@petshop/shared-types'
import { Alert, Badge, EmptyState, PageHeader } from '@/components/ui'
import { ShieldCheckIcon } from '@/components/icons'
import { serverApi } from '@/lib/api'
import { ler, talvez } from '@/lib/platform'
import { Falha, PlataformaShell, SemAcesso } from '../frame'
import { quando } from '../formato'
import { Filtros, JANELAS, type Janela } from './filtros'

/**
 * A trilha cross-tenant (MOD-ADMIN-08).
 *
 * É a mesma tabela que o MOD-SEC serve a cada estabelecimento, lida de outro lugar: lá,
 * sob RLS, com um tenant resolvido; aqui, como `app_maintenance`, sem tenant nenhum. As
 * duas leituras repetem o cursor e a janela de 92 dias **de propósito** — compartilhar o
 * código faria uma função com dois modos de isolamento, que é o tipo de coisa que se
 * confunde uma vez só e vaza para sempre.
 *
 * **Esta leitura se registra.** Abrir esta tela grava uma linha com o filtro usado, e é a
 * única razão pela qual a rota pode existir: quem vigia também é vigiado. Por isso, e não
 * por acaso, `platform.audit_read` aparece na própria lista logo abaixo.
 *
 * A paginação é só para a frente. O cursor é `(created_at, id)` e não tem inverso barato;
 * quem precisa voltar refaz a pergunta, que é o que o botão de recomeçar faz.
 */

export const dynamic = 'force-dynamic'

const DIA_MS = 24 * 60 * 60 * 1000
const RECUO: Record<Janela, number> = {
  '7d': 7 * DIA_MS,
  '30d': 30 * DIA_MS,
  /** O teto da rota. Pedir mais é 422, e a tela não oferece o que seria recusado. */
  '92d': 92 * DIA_MS,
}

const POR_PAGINA = 50

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function TrilhaPage({ searchParams }: PageProps) {
  const params = await searchParams
  const action = texto(params.action, 60)
  const tenantId = texto(params.tenantId, 40)
  const cursor = texto(params.cursor, 200)
  const janela = janelaDe(params.janela)

  const leitura = await ler(
    serverApi().listPlatformAuditLogs({
      limit: POR_PAGINA,
      from: new Date(Date.now() - RECUO[janela]).toISOString(),
      ...(action ? { action } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(cursor ? { cursor } : {}),
    }),
  )
  if (leitura.estado === 'fechado') return <SemAcesso />

  const tenants = (await talvez(serverApi().listPlatformTenants({ limit: 100 })))?.data ?? []

  return (
    <PlataformaShell active="trilha">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          eyebrow="Plataforma"
          title="Trilha"
          subtitle="Toda escrita do produto, de todos os estabelecimentos, pelos últimos 92 dias."
        />

        <Alert tone="accent" icon={<ShieldCheckIcon />} title="Esta consulta ficou registrada" role="status">
          A leitura da trilha grava a si mesma, com o filtro usado. É o que torna a
          existência desta tela defensável.
        </Alert>

        <Filtros
          action={action ?? ''}
          tenantId={tenantId ?? ''}
          janela={janela}
          tenants={tenants.map((tenant) => ({ id: tenant.id, name: tenant.name }))}
        />

        {leitura.estado === 'erro' ? (
          <Falha titulo="A trilha não veio" mensagem={leitura.mensagem} />
        ) : leitura.dado.items.length === 0 ? (
          <EmptyState
            title="Nenhuma linha neste recorte"
            description="Nada foi escrito com esses filtros na janela pedida. A trilha registra escrita — quem só consultou não deixa linha."
          />
        ) : (
          <>
            <ul className="card p-0">
              {leitura.dado.items.map((linha) => (
                <li key={linha.id} className="border-b border-line p-5 last:border-b-0">
                  <Linha entrada={linha} />
                </li>
              ))}
            </ul>

            <nav className="flex items-center justify-between gap-4" aria-label="Paginação">
              {cursor ? (
                <Link href="/plataforma/trilha" className="btn btn-ghost">
                  Voltar ao começo
                </Link>
              ) : (
                <span />
              )}

              {leitura.dado.nextCursor ? (
                <Link
                  href={`/plataforma/trilha?${busca({
                    action,
                    tenantId,
                    janela,
                    cursor: leitura.dado.nextCursor,
                  })}`}
                  className="btn btn-ghost"
                >
                  Mais antigas
                </Link>
              ) : (
                <p className="hint">Fim do recorte.</p>
              )}
            </nav>
          </>
        )}
      </div>
    </PlataformaShell>
  )
}

/**
 * Uma linha da trilha.
 *
 * O `before`/`after` fica dentro de um `<details>`: numa lista de cinquenta linhas, o
 * diff aberto de todas afogaria a única que interessa. O e-mail já chega mascarado do
 * backend — a trilha registra quem agiu, e não o contato de quem agiu.
 */
function Linha({ entrada }: { entrada: PlatformAuditEntry }) {
  const temDiff = entrada.before !== null || entrada.after !== null

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 font-mono text-sm font-medium">{entrada.action}</p>
        <div className="flex shrink-0 items-center gap-2">
          {entrada.outcome === 'DENIED' && <Badge tone="danger">negado</Badge>}
          <span className="hint tabular-nums">{quando(entrada.createdAt)}</span>
        </div>
      </div>

      <p className="hint mt-1">
        {entrada.actorName ?? 'Sistema'}
        {entrada.actorEmailMasked ? ` (${entrada.actorEmailMasked})` : ''} ·{' '}
        {entrada.tenant ? entrada.tenant.name : 'Plataforma'} · {entrada.entity}
        {entrada.entityId ? ` ${entrada.entityId.slice(0, 8)}` : ''}
        {entrada.ipAddress ? ` · ${entrada.ipAddress}` : ''}
      </p>

      {temDiff && (
        <details className="mt-2">
          <summary className="hint cursor-pointer select-none">Antes e depois</summary>
          <pre className="mt-2 overflow-x-auto rounded-2xl bg-chip px-4 py-3 text-xs leading-relaxed">
            {JSON.stringify({ antes: entrada.before, depois: entrada.after }, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}

/** A query da página seguinte: o mesmo recorte, com o cursor que a resposta devolveu. */
function busca(estado: {
  action: string | undefined
  tenantId: string | undefined
  janela: Janela
  cursor: string
}): string {
  const search = new URLSearchParams()
  if (estado.action) search.set('action', estado.action)
  if (estado.tenantId) search.set('tenantId', estado.tenantId)
  if (estado.janela !== '7d') search.set('janela', estado.janela)
  search.set('cursor', estado.cursor)
  return search.toString()
}

function texto(valor: unknown, max: number): string | undefined {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim().slice(0, max) : undefined
}

function janelaDe(valor: unknown): Janela {
  const aceitos = JANELAS.map((opcao) => opcao.value)
  return typeof valor === 'string' && (aceitos as string[]).includes(valor)
    ? (valor as Janela)
    : '7d'
}
