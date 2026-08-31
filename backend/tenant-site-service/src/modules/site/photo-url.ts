import { canonicalUrlOf } from './canonical.js'

/**
 * O endereço público de uma foto da galeria.
 *
 * **Não é URL assinada do R2**, ao contrário do álbum do pet. A assinada vale 15
 * minutos (RN-13 do MOD-PET) e a página fica em cache por dez — a foto quebraria na
 * metade da vida do cache, e um `og:image` assinado morreria antes de o buscador
 * voltar. Aqui a URL é estável e a leitura passa pelo host do tenant, que a repassa ao
 * serviço; o bucket continua privado.
 *
 * O `v` no fim é a versão: trocar a foto muda `updated_at`, muda a URL, e o navegador
 * que guardou a anterior por um ano não fica preso a ela.
 */
export function photoUrl(slug: string, photoId: string, updatedAt: Date): string {
  const version = Math.floor(updatedAt.getTime() / 1000)
  return `${canonicalUrlOf(slug)}/midia/${photoId}?v=${version}`
}
