import { DOCUMENT_KIND_LABELS, type PortalDocument } from '@petshop/shared-types'
import { Alert, Card } from '@/components/ui'
import { AlertTriangleIcon } from '@/components/icons'

/**
 * A lista de documentos do tutor (AC-01 de MOD-DOC-10).
 *
 * Componente de servidor: não há nada a interagir aqui. Cada linha é um link para a rota
 * do próprio Next, que busca a URL assinada e redireciona — um `<a>` apontando direto ao
 * bucket exigiria a assinatura viajar até o celular e ficar no histórico do navegador.
 *
 * **O documento em preparo aparece sem link**, e não some da lista: quem acabou de pagar
 * precisa ver que o recibo está a caminho, em vez de concluir que ele não existe.
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
        <Alert tone="accent" icon={<AlertTriangleIcon />} title="Documento em preparo" role="status">
          O arquivo está sendo gerado. Tente de novo em alguns instantes.
        </Alert>
      )}
      {aviso === 'erro' && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="Não foi possível abrir o documento">
          Tente novamente em instantes.
        </Alert>
      )}

      <Card>
        <p className="section-eyebrow">Documentos</p>

        {documentos.length === 0 ? (
          <p className="hint mt-3">
            Ainda não há documentos emitidos para você. Recibos, receituários e termos
            aceitos aparecem aqui assim que forem emitidos.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {documentos.map((documento) => (
              <li
                key={documento.id}
                className="border-line flex items-start justify-between gap-3 border-b py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{DOCUMENT_KIND_LABELS[documento.kind]}</p>
                  <p className="hint mt-0.5">
                    Nº {documento.number}
                    {documento.issuedAt && ` · ${data(documento.issuedAt)}`}
                    {documento.petName && ` · ${documento.petName}`}
                  </p>
                </div>

                {documento.ready ? (
                  <a
                    href={`/portal/documentos/${documento.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-ink shrink-0 text-xs font-medium hover:underline"
                  >
                    Abrir
                  </a>
                ) : (
                  <span className="hint shrink-0 text-xs">em preparo</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}

function data(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(
    new Date(iso),
  )
}
