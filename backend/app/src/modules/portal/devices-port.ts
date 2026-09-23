import { forgetDevice, registerDevice } from '../messaging/devices.js'

/**
 * A porta para os aparelhos do app, do lado do Portal (etapa 9 — push).
 *
 * A sétima porta do MOD-PORTAL. Separada da `messaging-port.ts` de propósito: aquela
 * pede ao motor que **entregue** um código, esta registra **onde** entregar — e os dublês
 * da primeira, que os testes do vínculo montam, não precisam saber que push existe.
 *
 * Não eleva permissão nenhuma: o tutor escreve na própria ficha, com `tutor:update_own`,
 * e o `tutorId` vem de `requireOwnScope`, nunca do corpo.
 */
export interface PortalDevicesPort {
  register(
    owner: { tenantId: string; tutorId: string },
    token: string,
    platform: 'ANDROID' | 'IOS',
  ): Promise<void>
  forget(owner: { tenantId: string; tutorId: string }, token: string): Promise<void>
}

const inProcess: PortalDevicesPort = {
  register: registerDevice,
  forget: forgetDevice,
}

let port: PortalDevicesPort | null = null

export function getDevicesPort(): PortalDevicesPort {
  return port ?? inProcess
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setDevicesPort(next: PortalDevicesPort | null): void {
  port = next
}
