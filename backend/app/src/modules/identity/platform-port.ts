/**
 * A equipe da plataforma, atrás de uma porta.
 *
 * `/v1/me` responde "esta pessoa é da equipe PetShop AI?" porque a moldura do Admin
 * precisa decidir se mostra o atalho para `/plataforma`. A pergunta é de identidade, o
 * dado é de `platform_admins` — que é do MOD-ADMIN —, e o MOD-IDENT não importa aquele
 * módulo: ele pergunta. Mesmo desenho da porta da agenda neste módulo.
 *
 * **A resposta é um booleano, e de propósito.** Nada além do atalho depende dela: o gate
 * da superfície da plataforma continua sendo o da porta (`resolvePlatformRequest` em
 * `app.ts`), que confere a ausência de Organization **e** a linha viva. Devolver o
 * `userId` de plataforma daqui convidaria alguém a usá-lo como credencial dentro de `/v1`,
 * onde o crachá não vale.
 */

export interface PlatformPort {
  isPlatformAdmin(clerkUserId: string): Promise<boolean>
}

/**
 * Sem o módulo da plataforma ligado, ninguém é da equipe.
 *
 * O padrão nega — é o lado seguro de um atalho que leva a um console: no máximo, quem é
 * da equipe não vê o botão e chega por URL, como chegava antes.
 */
const emptyPort: PlatformPort = {
  async isPlatformAdmin() {
    return false
  },
}

let port: PlatformPort = emptyPort

export function setPlatformPort(next: PlatformPort | null): void {
  port = next ?? emptyPort
}

export function getPlatform(): PlatformPort {
  return port
}
