import { DOCUMENT_KIND_LABELS, type PortalDocument } from '@petshop/shared-types'
import { Alert, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, DocumentIcon } from '@/components/icons'
import { RowChip, RowFile, RowItem, RowMeta, RowStack, RowText } from '../list'

/**
 * A lista de documentos do tutor (AC-01 de MOD-DOC-10).
 *
 * Componente de servidor: não há nada a interagir aqui. Cada linha é um link para a rota
 * do próprio Next, que busca a URL assinada e redireciona — um `<a>` apontando direto ao
 * bucket exigiria a assinatura viajar até o celular e ficar no histórico do navegador.
 *
 * **O documento em preparo aparece sem link**, e não some da lista: quem acabou de pagar
 * precisa ver que o recibo está a caminho, em vez de concluir que ele não existe. E é
 * por isso que ele é `RowItem` e não `RowFile`: a linha que não abre nada também não
 * levanta sob o dedo, e a diferença entre as duas se sente antes de se ler "em preparo".
 *
 * O "Abrir" de 12px que fechava a linha saiu com a lista nova: a linha inteira virou o
 * alvo, e o chevron diz o que o texto dizia — com o triplo da área para o polegar.
 */
export function Documentos({
  documentos,
  aviso,
}: {
  documentos: PortalDocument[]
  aviso: string | null
}) {
  return (
    <>
      {aviso === 'preparo' && (
        <Alert
          tone="accent"
          icon={<AlertTriangleIcon />}
          title="Documento em preparo"
          role="status"
        >
          O arquivo está sendo gerado. Tente de novo em alguns instantes.
        </Alert>
      )}
      {aviso === 'erro' && (
        <Alert
          tone="danger"
          icon={<AlertTriangleIcon />}
          title="Não foi possível abrir o documento"
        >
          Tente novamente em instantes.
        </Alert>
      )}

      <RowStack
        head={
          <SectionHead
            icon={<DocumentIcon />}
            tone="icon-system"
            title="Documentos"
            description={
              documentos.length === 0
                ? 'Recibos, receituários e termos aceitos aparecem aqui assim que forem emitidos.'
                : undefined
            }
          />
        }
      >
        {documentos.map((documento) => {
          const chip = <RowChip icon={<DocumentIcon />} tone="icon-system" />
          const texto = (
            <RowText
              title={DOCUMENT_KIND_LABELS[documento.kind]}
              hint={
                <>
                  Nº {documento.number}
                  {documento.issuedAt && ` · ${data(documento.issuedAt)}`}
                  {documento.petName && ` · ${documento.petName}`}
                </>
              }
            />
          )

          return documento.ready ? (
            <RowFile key={documento.id} href={`/portal/documentos/${documento.id}`}>
              {chip}
              {texto}
            </RowFile>
          ) : (
            <RowItem key={documento.id}>
              {chip}
              {texto}
              <RowMeta>
                <span className="hint">em preparo</span>
              </RowMeta>
            </RowItem>
          )
        })}
      </RowStack>
    </>
  )
}

function data(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}
