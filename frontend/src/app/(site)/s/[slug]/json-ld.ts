/**
 * `JSON.stringify` com `<` escrito como `<`: o mesmo JSON para quem o lê, e nenhuma
 * sequência que o HTML entenda como fim de `<script>` ou começo de comentário.
 *
 * Sozinho, o `JSON.stringify` não basta dentro de um `<script>`: ele não escapa `<`, e um
 * nome de estabelecimento com `</script>` fecharia a tag e abriria outra no host do
 * petshop — que é o mesmo host do Portal.
 */
export function jsonLdSeguro(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}
