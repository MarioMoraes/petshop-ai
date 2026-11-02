import {
  reopenTenant,
  terminateTenant,
  type ReopenResult,
  type TerminateResult,
} from '../identity/termination.js'

/**
 * O que o console pede ao MOD-IDENT para encerrar e reabrir um estabelecimento
 * (MOD-IDENT-10). O estado da conta é do MOD-IDENT; o console só decide quando.
 */
export interface TerminationPort {
  terminate(
    tenantId: string,
    input: { reason: string; actorUserId: string },
  ): Promise<TerminateResult>
  reopen(tenantId: string, input: { actorUserId: string }): Promise<ReopenResult>
}

const inProcess: TerminationPort = {
  terminate: terminateTenant,
  reopen: reopenTenant,
}

let port: TerminationPort = inProcess

export function getTerminationPort(): TerminationPort {
  return port
}

export function setTerminationPort(next: TerminationPort | null): void {
  port = next ?? inProcess
}
