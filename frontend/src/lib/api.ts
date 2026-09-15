import 'server-only'
import { cache } from 'react'
import { auth } from '@clerk/nextjs/server'
import { createApiClient, type ApiClient } from '@petshop/api-client'

/**
 * Cliente do gateway para uso no servidor.
 *
 * O token do Clerk fica no servidor: o browser nunca fala com o gateway direto.
 * Assim não há CORS a afrouxar nem token exposto ao JavaScript da página.
 */

/**
 * Endereço do gateway, lido em tempo de execução.
 *
 * Não é `NEXT_PUBLIC_`: este arquivo é `server-only` e o browser nunca fala com o
 * gateway. O prefixo público faria o Next **inlinear** o valor no build, e a imagem
 * de produção nasceria amarrada a um ambiente — em produção o gateway atende por
 * nome de container na rede interna, não pelo domínio externo. `NEXT_PUBLIC_API_URL`
 * fica como segunda opção para não quebrar o `.env` de quem já tem um.
 */
const baseUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'

/**
 * O token da requisição, emitido uma vez só.
 *
 * **Era um por chamada à API**, e o painel faz umas quatorze em paralelo: cada
 * `getToken({ template })` é uma ida ao Clerk, e a rajada estourava o limite da instância.
 * O pedido recusado caía, em silêncio, no token de sessão padrão — que o backend não lia
 * como tendo estabelecimento, e a tela quebrava com o 403 "Selecione um estabelecimento
 * para continuar" (2026-09-15). O `cache` do React vale por render de servidor, como o
 * `carregarMe` abaixo: todas as chamadas de uma página dividem o mesmo token, e o token
 * do template vive 60 segundos, bem mais que qualquer render.
 *
 * **A queda continua existindo, mas deixou de ser muda.** Sem o template o backend ainda
 * resolve o estabelecimento (lê `o.id` do token padrão), e perde só o `permVersion` e o
 * `mfa`, que ele trata como "não sei". O aviso no log é o que diz que isso aconteceu.
 */
const tokenDaRequisicao = cache(async (): Promise<string | null> => {
  const session = await auth()

  try {
    const token = await session.getToken({ template: 'petshop' })
    if (token) return token
    console.warn('[auth] o template petshop voltou vazio; seguindo com o token de sessão padrão')
  } catch (error) {
    console.warn(
      '[auth] o Clerk não emitiu o token do template petshop; seguindo com o token de sessão padrão',
      error instanceof Error ? error.message : error,
    )
  }

  return session.getToken()
})

export function serverApi(): ApiClient {
  return createApiClient({ baseUrl, getToken: tokenDaRequisicao })
}

/**
 * `/v1/me` da requisição corrente, buscado uma vez só.
 *
 * Layout e página são dois componentes que renderizam na mesma requisição e precisam da
 * mesma resposta: o layout monta a moldura e filtra o menu, a página decide o que mostrar
 * pela mesma matriz de permissões. Sem o `cache`, isso são duas idas ao gateway por
 * navegação — e é justamente a chamada que segura a tela inteira, porque tudo o mais só
 * começa depois de saber quem é quem.
 *
 * O `cache` do React vale por render de servidor, não entre requisições: não há resposta
 * de um usuário aparecendo na tela de outro, que é a pergunta que essa palavra costuma
 * levantar.
 */
export const carregarMe = cache(() => serverApi().me())
