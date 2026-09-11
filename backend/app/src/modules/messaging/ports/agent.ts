import type { AgentInboundKind } from '@petshop/shared-types'

/**
 * O MOD-AI, atrás de uma porta (§5 do PRD agentes_ia_15).
 *
 * A direção importa: **quem chama é a mensageria**, que é dona do canal e da tabela
 * `messages`, e quem responde é o módulo da conversa. O inverso — o agente lendo o
 * webhook — faria dois módulos conhecerem o formato de payload da Evolution, e o dia em
 * que ela mudar o nome de um campo os dois quebrariam.
 *
 * O que atravessa a porta já é **fato resolvido**: o telefone normalizado, o tutor (ou a
 * ausência dele), o tipo do que chegou e o texto em claro. Nada de `remoteJid`, nada de
 * `messageType` — o vocabulário do provedor morre em `inbound.ts`.
 */

export interface InboundMessage {
  tenantId: string
  /** A linha que acabou de nascer em `messages`, para o turno apontar para ela. */
  messageId: string
  /** E.164. É a chave da conversa, e não o tutor: quem escreve pode não ter ficha. */
  phone: string
  /** O hash de busca do telefone, no mesmo namespace do cadastro do tutor. */
  phoneHash: string
  /**
   * A ficha, quando o telefone casou com **exatamente uma**.
   *
   * `null` com `candidates` vazio é o número desconhecido (AC-02); `null` com dois ou
   * mais é o telefone ambíguo (AC-03), e nesse caso o módulo não escolhe.
   */
  tutorId: string | null
  candidates: string[]
  kind: AgentInboundKind
  /** Vazio quando o que chegou não é texto — o corpo de mídia não se guarda (AC-05). */
  text: string
  receivedAt: Date
}

export interface AgentInboundPort {
  onInbound(message: InboundMessage): Promise<void>
}

/**
 * Sem o módulo do agente ligado, a mensagem recebida vira linha e para por aí.
 *
 * É o estado correto de um processo que hospeda a mensageria sem o MOD-AI — e é o que a
 * suíte do MOD-NOTIF exercita, porque nenhum teste de lá liga a porta.
 */
const noopPort: AgentInboundPort = {
  async onInbound() {
    // nada: a mensagem já está gravada, e não há conversa para abrir.
  },
}

let port: AgentInboundPort = noopPort

export function setAgentInboundPort(next: AgentInboundPort | null): void {
  port = next ?? noopPort
}

export function getAgentInboundPort(): AgentInboundPort {
  return port
}
