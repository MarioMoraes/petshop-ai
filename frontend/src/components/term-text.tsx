'use client'

import { parseTermBody, type TermBlock, type TermSpan } from '@petshop/shared-types'

/**
 * O texto do termo, desenhado a partir dos blocos.
 *
 * **Sem `dangerouslySetInnerHTML`.** O corpo é digitado por alguém do estabelecimento, e
 * o parser de `shared-types` devolve blocos justamente para que nem esta tela nem o PDF
 * precisem confiar no texto: cada um escapa do seu jeito. É o mesmo `parseTermBody` que
 * o papel do aceite usa, então o que se lê aqui é o que sai impresso.
 */
export function TextoDoTermo({ body }: { body: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      {parseTermBody(body).map((block, index) => (
        <Bloco key={index} block={block} />
      ))}
    </div>
  )
}

function Bloco({ block }: { block: TermBlock }) {
  if (block.type === 'heading') {
    return <p className="section-eyebrow mt-2">{texto(block.spans)}</p>
  }
  if (block.type === 'list') {
    return (
      <ul className="list-disc pl-5">
        {block.items.map((item, index) => (
          <li key={index}>{texto(item)}</li>
        ))}
      </ul>
    )
  }
  return <p>{texto(block.spans)}</p>
}

function texto(spans: TermSpan[]) {
  return spans.map((span, index) =>
    span.bold ? (
      <strong key={index} className="font-semibold">
        {span.text}
      </strong>
    ) : (
      <span key={index}>{span.text}</span>
    ),
  )
}
