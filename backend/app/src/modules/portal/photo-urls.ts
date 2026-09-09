import { PHOTO_URL_TTL_SECONDS } from '@petshop/shared-types'
import { getStorage } from '../../shared/storage.js'
import { logger } from '../../shared/logger.js'

/**
 * As fotos do pet, do lado de quem só as **mostra**.
 *
 * É o recorte de leitura do álbum do MOD-PET, e a assimetria é deliberada: quem publica
 * foto é a equipe (MOD-PET-04) ou o tutor por uma rota que passa pelo pipeline de imagem
 * daquele módulo. O Portal nunca grava nem apaga objeto.
 *
 * **Na fatia 11 este arquivo deixou de abrir o próprio `S3Client`.** Enquanto o Portal
 * era outro processo, ele tinha de ter um: eram duas conexões ao mesmo bucket porque
 * eram duas máquinas. No mesmo processo, dois clientes sobre as mesmas credenciais são
 * duas piscinas de socket e duas configurações que um dia divergem. Quem fala com o R2 é
 * `shared/storage.ts`, e o que fica aqui é o **recorte**: uma função que só assina, sem
 * `put` e sem `remove` — o que não existe não pode ser chamado por engano.
 *
 * Nenhuma URL vem do banco: `pet_photos.variants` guarda **chave de objeto**, e a URL sai
 * assinada na leitura com a validade curta do RN-13 do MOD-PET. URL guardada em banco
 * nasce vencida.
 *
 * Assinar é cálculo local — não há ida ao R2 aqui —, e por isso assinar a capa de uma
 * lista inteira de pets não custa rede.
 */

/**
 * A URL de uma variante, ou `null`.
 *
 * **Nunca lança**, e essa é a diferença que importa em relação ao álbum: lá, o storage
 * indisponível vira 502 porque a operação *é* a foto. Aqui a foto é enfeite da ficha, e
 * derrubar "Meus pets" inteiro porque o R2 piscou tiraria do tutor o histórico, a idade e
 * o próximo agendamento por causa de um retrato.
 *
 * É também o que absorve a diferença de contrato entre os dois lados: `getStorage()`
 * lança `StorageUnavailableError` quando falta credencial, e aqui isso é um `null`.
 */
export async function signPhotoUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null

  try {
    return await getStorage().signedUrl(key, PHOTO_URL_TTL_SECONDS)
  } catch (error) {
    logger.warn({ err: error, key }, 'falha ao assinar a URL da foto')
    return null
  }
}

/** A chave de uma variante dentro do `variants` de `pet_photos`. */
export function variantKey(variants: unknown, variant: 'thumb' | 'medium' | 'full'): string | null {
  if (!variants || typeof variants !== 'object') return null
  const value = (variants as Record<string, unknown>)[variant]
  return typeof value === 'string' ? value : null
}
