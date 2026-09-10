/**
 * A grade de jobs, atrás de uma porta (MOD-ADMIN-04).
 *
 * O agendador mora em `src/worker`, que é infraestrutura do processo e **importa** os
 * módulos — todos os consumidores e todas as grades passam por lá. Um `import` daqui para
 * lá inverteria essa direção e faria o módulo que observa depender do que ele observa.
 *
 * A porta é ligada no registro do módulo, em `gateway/routes.ts`, como
 * `setAppointmentsPort` é ligada no registro da agenda. Sem ela, o painel responde com a
 * grade vazia — que é a verdade de um processo sem agendador, e não um erro.
 */

export interface JobGridEntry {
  name: string
  schedule: string
  nextRunAt: Date | null
  intervalMs: number | null
}

export interface JobGridPort {
  describe(now?: Date): JobGridEntry[]
}

const emptyPort: JobGridPort = {
  describe: () => [],
}

let port: JobGridPort = emptyPort

export function setJobGridPort(next: JobGridPort | null): void {
  port = next ?? emptyPort
}

export function getJobGrid(): JobGridPort {
  return port
}
