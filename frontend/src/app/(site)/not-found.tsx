/**
 * O 404 do host do tenant.
 *
 * Sem logo do produto, sem link para o Admin e sem nome de petshop nenhum: quem chega
 * aqui pediu um endereço que não corresponde a estabelecimento algum — ou a um que
 * está fora do ar —, e as duas coisas devem ser indistinguíveis. Dizer "este petshop
 * existe mas está despublicado" entregaria a um visitante anônimo informação sobre a
 * instalação que ele não tem por que ter.
 */
export default function SiteNotFound() {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold text-ink">Página Não Encontrada</h1>
      <p className="text-sm text-muted">O endereço que você abriu não existe.</p>
    </main>
  )
}
