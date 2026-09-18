'use client'

import type { ImportBatch, ImportEntity, ImportEntityInfo, ImportReport } from '@petshop/api-client'
import { useRef, useState, useTransition } from 'react'
import { AlertTriangleIcon, DownloadIcon, SettingsIcon, UploadIcon } from '@/components/icons'
import { Modal } from '@/components/modal'
import { Alert, Badge, Button, Card, Field, SectionHead } from '@/components/ui'
import { aplicarImportacao, conferirImportacao, desfazerImportacao } from './actions'

/**
 * A importação da base anterior — o assistente de quatro passos.
 *
 * Não é uma faixa de abas: são quatro cargas **independentes**, cada uma com o seu
 * arquivo, e a ordem entre elas é de DEPENDÊNCIA, não de navegação. O pet aponta o dono
 * pelo CPF; o agendamento aponta o pet e o profissional pelo nome. Numerar os passos é o
 * que faz o operador subir na ordem em que funciona — e o backend recusa fora de ordem
 * nomeando o que faltou ("Tutor 123.456.789-09 não encontrado — importe os tutores
 * antes").
 *
 * **O fluxo de cada passo tem sempre dois tempos.** Escolher o arquivo *confere* e não
 * grava nada: devolve o mapeamento sugerido e o relatório linha a linha. Conferir e
 * clicar em Aplicar *grava*. Um passo só, que gravasse no primeiro clique, já teria
 * criado quatrocentos pets errados quando alguém percebesse que a coluna "Nome" era a do
 * dono.
 *
 * O tom é `icon-system` nas quatro seções, e não um por passo: a regra 3 de
 * `docs/design-formularios.md` manda um tom por tela, o do domínio no menu — esta mora
 * em Configurações. O que muda de uma seção para a outra é o número, não a cor.
 */

/** Onde cada passo está, na sessão atual da tela. */
interface EstadoDoPasso {
  fileName: string
  /** Data URL do arquivo. Reenviado no aplicar — ver a nota em `actions.ts`. */
  content: string
  report: ImportReport
  /** Ajustado à mão sobre a sugestão do farejador. */
  mapping: Record<string, number>
  /**
   * O mapeamento mudou desde a última conferência.
   *
   * Trocar uma coluna **não** reconfere sozinho: a conferência percorre o arquivo
   * inteiro e consulta o banco por linha, então ajustar cinco campos dispararia cinco
   * varreduras de quatrocentas linhas — e as quatro primeiras seriam jogadas fora.
   * Enquanto está sujo, o relatório na tela é de OUTRO mapeamento, e por isso o Aplicar
   * some: aplicar com o relatório errado na frente é exatamente o que o passo de
   * conferência existe para impedir.
   */
  sujo: boolean
  aplicado: boolean
}

const NAO_MAPEADO = ''

type Passos = Partial<Record<ImportEntity, EstadoDoPasso>>

export function ImportacaoPanel({
  entities,
  batches,
}: {
  entities: ImportEntityInfo[]
  batches: ImportBatch[]
}) {
  const [passos, setPassos] = useState<Passos>({})
  const [aberto, setAberto] = useState<ImportEntity | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [confirmacao, setConfirmacao] = useState<Confirmacao | null>(null)
  const [pendente, iniciar] = useTransition()

  const atualizarPasso = (entity: ImportEntity, patch: Partial<EstadoDoPasso>): void =>
    setPassos((atual) => {
      const passo = atual[entity]
      if (!passo) return atual
      return { ...atual, [entity]: { ...passo, ...patch } }
    })

  /* ─────────────────────────────────────────── Conferir */

  const conferir = (
    info: ImportEntityInfo,
    fileName: string,
    content: string,
    mapping?: Record<string, number>,
  ): void =>
    iniciar(async () => {
      setErro(null)
      setAviso(null)

      const resposta = await conferirImportacao({
        entity: info.entity,
        fileName,
        content,
        ...(mapping ? { mapping } : {}),
        onExisting: 'IGNORAR',
      })

      if (!resposta.ok || !resposta.report) {
        setErro(resposta.error ?? 'Não foi possível ler o arquivo.')
        return
      }

      const report = resposta.report
      setPassos((atual) => ({
        ...atual,
        [info.entity]: {
          fileName,
          content,
          report,
          mapping: report.mapping,
          sujo: false,
          aplicado: false,
        },
      }))
      setAberto(info.entity)

      if (report.missing.length > 0) {
        setErro(`Aponte abaixo a coluna de: ${report.missing.join(', ')}.`)
      } else if (report.counts.failed > 0) {
        setAviso(
          `${report.rowCount} linha(s) lidas — ${report.counts.failed} com problema. Confira abaixo.`,
        )
      }
    })

  const escolherArquivo = (info: ImportEntityInfo, file: File): void => {
    const leitor = new FileReader()
    leitor.onload = () => conferir(info, file.name, String(leitor.result ?? ''))
    leitor.onerror = () => setErro('Não foi possível ler o arquivo escolhido.')
    // `readAsDataURL` e não `readAsText`: quem decide a codificação é o servidor, olhando
    // os bytes. Ler como texto aqui destruiria os acentos de todo arquivo salvo pelo
    // Excel em pt-BR antes de alguém poder detectá-los.
    leitor.readAsDataURL(file)
  }

  /* ─────────────────────────────────────────── Aplicar */

  const aplicar = (info: ImportEntityInfo, onExisting: 'IGNORAR' | 'ATUALIZAR'): void => {
    const passo = passos[info.entity]
    if (!passo) return

    iniciar(async () => {
      setErro(null)
      setAviso(null)

      const resposta = await aplicarImportacao({
        entity: info.entity,
        fileName: passo.fileName,
        content: passo.content,
        mapping: passo.mapping,
        onExisting,
      })

      if (!resposta.ok || !resposta.report) {
        setErro(resposta.error ?? 'Não foi possível aplicar a importação.')
        return
      }

      const contas = resposta.report.counts
      atualizarPasso(info.entity, { report: resposta.report, aplicado: true })
      setAviso(
        `${contas.created} criado(s), ${contas.updated} atualizado(s)` +
          (contas.failed > 0 ? ` — ${contas.failed} linha(s) ficaram de fora.` : '.'),
      )
    })
  }

  /* ─────────────────────────────────────────── Desfazer */

  const desfazer = (batch: ImportBatch): void =>
    iniciar(async () => {
      setErro(null)
      setAviso(null)

      const resposta = await desfazerImportacao(batch.id)
      if (!resposta.ok || !resposta.resultado) {
        setErro(resposta.error ?? 'Não foi possível desfazer o lote.')
        return
      }

      const { removed, keptTutors } = resposta.resultado
      setAviso(
        keptTutors > 0
          ? `Lote marcado como desfeito — ${keptTutors} tutor(es) foram mantidos.`
          : `${removed} registro(s) desfeito(s).`,
      )
    })

  /* ─────────────────────────────────────────── Tela */

  if (entities.length === 0) {
    return (
      <Alert tone="danger" icon={<AlertTriangleIcon />} title="Importação indisponível">
        Não foi possível carregar o catálogo de campos. Tente novamente em instantes.
      </Alert>
    )
  }

  return (
    <div className="space-y-5">
      {erro && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="Confira antes de seguir">
          {erro}
        </Alert>
      )}
      {aviso && (
        <Alert tone="accent" icon={<UploadIcon />} title="Importação" role="status">
          {aviso}
        </Alert>
      )}

      <ComoFunciona />

      {entities.map((info, indice) => (
        <Passo
          key={info.entity}
          info={info}
          numero={indice + 1}
          passo={passos[info.entity]}
          expandido={aberto === info.entity}
          lotes={batches.filter((batch) => batch.entity === info.entity)}
          pendente={pendente}
          onAbrir={() => setAberto(info.entity)}
          onArquivo={(file) => escolherArquivo(info, file)}
          onMapear={(mapping) => atualizarPasso(info.entity, { mapping, sujo: true })}
          onReconferir={() => {
            const passo = passos[info.entity]
            if (passo) conferir(info, passo.fileName, passo.content, passo.mapping)
          }}
          onAplicar={(onExisting) => setConfirmacao({ tipo: 'aplicar', info, onExisting })}
          onDesfazer={(batch) => setConfirmacao({ tipo: 'desfazer', batch })}
        />
      ))}

      <DepoisDeImportar />

      <Confirmar
        confirmacao={confirmacao}
        passos={passos}
        pendente={pendente}
        onFechar={() => setConfirmacao(null)}
        onConfirmar={(escolha) => {
          setConfirmacao(null)
          if (escolha.tipo === 'aplicar') aplicar(escolha.info, escolha.onExisting)
          else desfazer(escolha.batch)
        }}
      />
    </div>
  )
}

/* ═══════════════════════════════════════════════════ Um passo */

function Passo({
  info,
  numero,
  passo,
  expandido,
  lotes,
  pendente,
  onAbrir,
  onArquivo,
  onMapear,
  onReconferir,
  onAplicar,
  onDesfazer,
}: {
  info: ImportEntityInfo
  numero: number
  passo: EstadoDoPasso | undefined
  expandido: boolean
  lotes: ImportBatch[]
  pendente: boolean
  onAbrir: () => void
  onArquivo: (file: File) => void
  onMapear: (mapping: Record<string, number>) => void
  onReconferir: () => void
  onAplicar: (onExisting: 'IGNORAR' | 'ATUALIZAR') => void
  onDesfazer: (batch: ImportBatch) => void
}) {
  const seletor = useRef<HTMLInputElement>(null)

  const aplicados = lotes.filter((lote) => lote.status === 'APLICADO')
  const total = aplicados.reduce((soma, lote) => soma + lote.createdCount, 0)

  return (
    <>
      <Card className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <SectionHead
            icon={<SettingsIcon />}
            tone="icon-system"
            eyebrow={`${String(numero).padStart(2, '0')} · ${
              total > 0
                ? `${total} registro(s) em ${aplicados.length} carga(s)`
                : 'Nada importado ainda'
            }`}
            title={info.label}
            description={info.description}
          />

          <div className="flex shrink-0 items-center gap-2">
            <Button icon={<DownloadIcon />} onClick={() => baixarModelo(info)}>
              Modelo
            </Button>
            <Button
              icon={<UploadIcon />}
              busy={pendente}
              busyLabel="Conferindo…"
              onClick={() => seletor.current?.click()}
            >
              Escolher arquivo
            </Button>
            <input
              ref={seletor}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) onArquivo(file)
                // Sem isto, escolher o mesmo arquivo duas vezes seguidas não dispara
                // nada — e é o que se faz depois de corrigir a planilha e salvar por cima.
                event.target.value = ''
              }}
            />
          </div>
        </div>

        {lotes.length > 0 && (
          <Historico lotes={lotes} pendente={pendente} onDesfazer={onDesfazer} />
        )}

        {passo && !expandido && (
          <Button variant="ghost" onClick={onAbrir}>
            Ver a conferência de {passo.fileName}
          </Button>
        )}
      </Card>

      {passo && expandido && (
        <Card tone="soft" className="space-y-5">
          <SectionHead
            icon={<UploadIcon />}
            tone="icon-system"
            eyebrow="Conferência"
            title={passo.fileName}
            description="Nada foi gravado ainda. Confira as colunas reconhecidas e o que vai acontecer com cada linha."
          />

          <ResumoDoArquivo report={passo.report} />

          <Mapeamento
            info={info}
            headers={passo.report.headers}
            mapping={passo.mapping}
            disabled={pendente}
            onChange={onMapear}
          />

          <Relatorio report={passo.report} />

          {passo.sujo ? (
            <div className="flex flex-wrap items-center justify-end gap-3">
              <p className="hint">O relatório acima é do mapeamento anterior.</p>
              <Button busy={pendente} busyLabel="Conferindo…" onClick={onReconferir}>
                Conferir de novo
              </Button>
            </div>
          ) : (
            !passo.aplicado &&
            passo.report.missing.length === 0 && (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  busy={pendente}
                  busyLabel="Aplicando…"
                  onClick={() => onAplicar('ATUALIZAR')}
                >
                  Aplicar atualizando o que já existe
                </Button>
                <Button
                  busy={pendente}
                  busyLabel="Aplicando…"
                  disabled={passo.report.counts.created === 0}
                  onClick={() => onAplicar('IGNORAR')}
                >
                  Aplicar {passo.report.counts.created} novo(s)
                </Button>
              </div>
            )
          )}
        </Card>
      )}
    </>
  )
}

/* ═══════════════════════════════════════════════════ Resumo do arquivo */

/**
 * O que o farejador decidiu.
 *
 * Aparece porque separador e codificação **não são declarados no arquivo**: mostrar a
 * decisão é o que permite ao operador desconfiar do total sabendo de onde reclamar.
 */
function ResumoDoArquivo({ report }: { report: ImportReport }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{report.rowCount} linha(s)</Badge>
        <Badge>separador {report.delimiter === '\t' ? 'tabulação' : report.delimiter}</Badge>
        <Badge>{report.encoding}</Badge>
        {report.counts.created > 0 && <Badge tone="success">{report.counts.created} a criar</Badge>}
        {report.counts.updated > 0 && (
          <Badge tone="accent">{report.counts.updated} a atualizar</Badge>
        )}
        {report.counts.ignored > 0 && <Badge>{report.counts.ignored} já existem</Badge>}
        {report.counts.failed > 0 && (
          <Badge tone="danger">{report.counts.failed} com problema</Badge>
        )}
      </div>

      {report.missing.length > 0 && (
        <p className="hint">
          Aponte abaixo a coluna de <strong>{report.missing.join(', ')}</strong> — sem ela nada pode
          ser importado.
        </p>
      )}

      {report.previousBatch && (
        <p className="hint">
          Este mesmo arquivo já foi aplicado em{' '}
          {new Date(report.previousBatch.createdAt).toLocaleDateString('pt-BR')}. Aplicar de novo
          não duplica nada — o que já entrou é ignorado.
        </p>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════ Mapeamento */

/**
 * Coluna do arquivo → campo nosso.
 *
 * `<select className="field">` é o certo aqui: a lista de colunas de uma planilha é
 * curta e fechada — não cresce com a operação do cliente. É o mesmo critério da espécie
 * e do porte no cadastro de pet.
 */
function Mapeamento({
  info,
  headers,
  mapping,
  disabled,
  onChange,
}: {
  info: ImportEntityInfo
  headers: string[]
  mapping: Record<string, number>
  disabled: boolean
  onChange: (mapping: Record<string, number>) => void
}) {
  const trocar = (field: string, valor: string): void => {
    const proximo = { ...mapping }
    if (valor === NAO_MAPEADO) delete proximo[field]
    else proximo[field] = Number(valor)
    onChange(proximo)
  }

  return (
    <div className="space-y-3">
      <p className="label">Colunas reconhecidas</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {info.fields.map((campo) => {
          const atual = mapping[campo.field]
          return (
            <Field
              key={campo.field}
              label={campo.required ? `${campo.label} *` : campo.label}
              htmlFor={`map-${info.entity}-${campo.field}`}
              hint={campo.hint ?? undefined}
            >
              <select
                id={`map-${info.entity}-${campo.field}`}
                className="field"
                value={atual === undefined ? NAO_MAPEADO : String(atual)}
                disabled={disabled}
                onChange={(event) => trocar(campo.field, event.target.value)}
              >
                <option value={NAO_MAPEADO}>— não importar —</option>
                {headers.map((header, indice) => (
                  <option key={`${header}-${indice}`} value={indice}>
                    {header || `(coluna ${indice + 1} sem título)`}
                  </option>
                ))}
              </select>
            </Field>
          )
        })}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════ Relatório */

type Tom = 'neutral' | 'accent' | 'success' | 'danger'

const RESULTADO: Record<string, { tone: Tom; label: string }> = {
  CRIADO: { tone: 'success', label: 'Criar' },
  ATUALIZADO: { tone: 'accent', label: 'Atualizar' },
  IGNORADO: { tone: 'neutral', label: 'Já existe' },
  ERRO: { tone: 'danger', label: 'Problema' },
}

/**
 * O relatório linha a linha.
 *
 * As linhas com **problema** vêm todas do servidor, sempre — são elas que o operador
 * conserta, e cortá-las faria a segunda tentativa descobrir o que a primeira já sabia. O
 * que deu certo vem por amostra, com o total no resumo acima.
 */
function Relatorio({ report }: { report: ImportReport }) {
  if (report.rows.length === 0) return null

  return (
    <div className="space-y-3">
      <p className="label">Linha por linha</p>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="hint px-4 py-3 font-medium">Linha</th>
              <th className="hint px-4 py-3 font-medium">Referência</th>
              <th className="hint px-4 py-3 font-medium">O que acontece</th>
              <th className="hint px-4 py-3 font-medium">Observação</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((linha) => {
              const resultado = RESULTADO[linha.outcome] ?? {
                tone: 'neutral' as Tom,
                label: linha.outcome,
              }
              return (
                <tr
                  key={`${linha.lineNo}-${linha.ref ?? ''}`}
                  className="border-b border-line last:border-b-0"
                >
                  <td className="px-4 py-3 tabular-nums">{linha.lineNo}</td>
                  <td className="px-4 py-3">{linha.ref ?? '—'}</td>
                  <td className="px-4 py-3">
                    <Badge tone={resultado.tone}>{resultado.label}</Badge>
                  </td>
                  <td className="hint px-4 py-3">{linha.message ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {report.truncated && (
        <p className="hint">
          Mostrando as primeiras linhas que deram certo — as com problema aparecem todas.
        </p>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════ Histórico */

function Historico({
  lotes,
  pendente,
  onDesfazer,
}: {
  lotes: ImportBatch[]
  pendente: boolean
  onDesfazer: (batch: ImportBatch) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="hint py-2 font-medium">Arquivo</th>
            <th className="hint py-2 font-medium">Quando</th>
            <th className="hint py-2 text-right font-medium">Criados</th>
            <th className="hint py-2 text-right font-medium">Atualizados</th>
            <th className="hint py-2 text-right font-medium">Com erro</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lotes.map((lote) => (
            <tr key={lote.id} className="border-b border-line last:border-b-0">
              <td className="py-2.5">{lote.fileName}</td>
              <td className="py-2.5">{new Date(lote.createdAt).toLocaleString('pt-BR')}</td>
              <td className="py-2.5 text-right tabular-nums">{lote.createdCount}</td>
              <td className="py-2.5 text-right tabular-nums">{lote.updatedCount}</td>
              <td className="py-2.5 text-right tabular-nums">
                {lote.failedCount > 0 ? <Badge tone="danger">{lote.failedCount}</Badge> : '—'}
              </td>
              <td className="py-2.5 text-right">
                {lote.status === 'DESFEITO' ? (
                  <Badge>Desfeito</Badge>
                ) : (
                  <Button variant="ghost" disabled={pendente} onClick={() => onDesfazer(lote)}>
                    Desfazer
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ═══════════════════════════════════════════════════ Confirmação */

type Confirmacao =
  | { tipo: 'aplicar'; info: ImportEntityInfo; onExisting: 'IGNORAR' | 'ATUALIZAR' }
  | { tipo: 'desfazer'; batch: ImportBatch }

function Confirmar({
  confirmacao,
  passos,
  pendente,
  onFechar,
  onConfirmar,
}: {
  confirmacao: Confirmacao | null
  passos: Passos
  pendente: boolean
  onFechar: () => void
  onConfirmar: (confirmacao: Confirmacao) => void
}) {
  const aplicar = confirmacao?.tipo === 'aplicar' ? confirmacao : null
  const desfazer = confirmacao?.tipo === 'desfazer' ? confirmacao : null
  const contas = aplicar ? passos[aplicar.info.entity]?.report.counts : undefined

  return (
    <Modal
      open={confirmacao !== null}
      onClose={onFechar}
      icon={<UploadIcon />}
      tone="icon-system"
      eyebrow="Importação"
      busy={pendente}
      title={
        aplicar
          ? `Aplicar em ${aplicar.info.label}?`
          : desfazer
            ? `Desfazer a carga de ${desfazer.batch.fileName}?`
            : ''
      }
      footer={
        <>
          <Button variant="ghost" disabled={pendente} onClick={onFechar}>
            Cancelar
          </Button>
          <Button
            busy={pendente}
            busyLabel="Aplicando…"
            onClick={() => confirmacao && onConfirmar(confirmacao)}
          >
            {aplicar ? 'Aplicar' : 'Desfazer'}
          </Button>
        </>
      }
    >
      {aplicar && contas && (
        <div className="space-y-3">
          <p>
            {contas.created} para criar, {contas.updated} para atualizar, {contas.ignored} já
            existentes e {contas.failed} com problema — essas ficam de fora.
          </p>
          <p className="hint">
            A carga é idempotente: reenviar o arquivo corrigido depois não duplica nada.
            {aplicar.onExisting === 'ATUALIZAR'
              ? ' Os cadastros que já existem serão sobrescritos com o que a planilha traz.'
              : ' Os cadastros que já existem ficam como estão.'}
          </p>
        </div>
      )}

      {desfazer && (
        <div className="space-y-3">
          <p>{textoDoDesfazer(desfazer.batch)}</p>
          <p className="hint">
            Só o que esta carga <strong>criou</strong> é desfeito — o que ela atualizou fica como
            está.
          </p>
        </div>
      )}
    </Modal>
  )
}

function textoDoDesfazer(batch: ImportBatch): string {
  if (batch.entity === 'TUTOR') {
    return (
      `Os ${batch.createdCount} tutor(es) desta carga FICAM: a chave é o CPF ou o celular, ` +
      'então reenviar o arquivo corrigido os atualiza no lugar. Apagar um tutor derrubaria ' +
      'pets, agenda, extrato e histórico ligados a ele.'
    )
  }
  if (batch.entity === 'PROFISSIONAL') {
    return (
      `Os ${batch.createdCount} profissional(is) criados são DESATIVADOS, não apagados: o ` +
      'nome de quem executou um atendimento precisa continuar legível no histórico. Quem ' +
      'tiver horário futuro marcado não é desligado sem reatribuição.'
    )
  }
  if (batch.entity === 'AGENDA') {
    return (
      `Cancela os ${batch.createdCount} agendamento(s) que esta carga criou, sem taxa e sem ` +
      'avisar ninguém — a carga entrou em silêncio, e o cliente não soube dela.'
    )
  }
  return (
    `Exclui os ${batch.createdCount} pet(s) que esta carga criou. Se algum já tiver horário ` +
    'marcado, nada é desfeito — cancele a agenda primeiro.'
  )
}

/* ═══════════════════════════════════════════════════ Texto de apoio */

function ComoFunciona() {
  return (
    <Card className="space-y-2">
      <p className="label">Como funciona</p>
      <p className="hint">
        Exporte cada lista do sistema antigo em <strong>CSV</strong> e suba na ordem abaixo — cada
        passo depende do anterior. Escolher o arquivo só <strong>confere</strong>: nada é gravado
        até você clicar em Aplicar. Os cabeçalhos podem ser os do sistema antigo; o sistema
        reconhece os nomes mais comuns e você corrige o que ficou errado.
      </p>
      <p className="hint">
        Da agenda, traga só o que <strong>ainda vai acontecer</strong>. Horário que já passou não
        entra: ele seria marcado como falta na hora seguinte, com taxa e mensagem, e apareceria num
        relatório de movimento que este sistema não viveu.
      </p>
    </Card>
  )
}

function DepoisDeImportar() {
  return (
    <Card className="space-y-4">
      <p className="label">Depois de importar</p>

      <div className="space-y-1">
        <p className="font-medium">1. Cadastre a jornada de cada profissional</p>
        <p className="hint">
          Em <strong>Agenda › Profissionais</strong>. A planilha não traz horário de trabalho, e sem
          ele nenhum agendamento entra — o sistema recusa dizendo que a pessoa não atende naquele
          horário.
        </p>
      </div>

      <div className="space-y-1">
        <p className="font-medium">2. Confira os serviços de cada um</p>
        <p className="hint">
          Quem não está habilitado num serviço não aparece no seletor dele. É o que impede marcar
          tosa com quem só dá banho — e o que faz a importação da agenda recusar a linha.
        </p>
      </div>

      <div className="space-y-1">
        <p className="font-medium">3. Revise os cadastros parecidos</p>
        <p className="hint">
          A carga reconhece quem já existe pelo CPF, CNPJ ou celular. Dois cadastros do mesmo
          cliente com dados diferentes passam os dois — a unificação de fichas, na busca de tutores,
          é onde se junta o que ficou dobrado.
        </p>
      </div>
    </Card>
  )
}

/* ═══════════════════════════════════════════════════ Modelo CSV */

/**
 * Baixa o modelo do passo.
 *
 * O conteúdo vem do servidor — é o **mesmo** catálogo que valida a carga —, então o
 * modelo nunca diverge do que o sistema aceita. O BOM na frente é o que faz o Excel em
 * pt-BR abrir os acentos certos ao dar duplo clique.
 */
function baixarModelo(info: ImportEntityInfo): void {
  const blob = new Blob([`﻿${info.template}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const ancora = document.createElement('a')
  ancora.href = url
  ancora.download = `modelo-${info.entity.toLowerCase()}.csv`
  ancora.click()
  URL.revokeObjectURL(url)
}
