/**
 * O teto de tokens recusados, que corre **antes** da verificação.
 *
 * O `@fastify/rate-limit` pendura o limitador como hook de rota, e o Fastify roda hook de
 * rota depois dos da instância: a autenticação, que é da instância, decide primeiro. O
 * que ela recusa sai com 401 e nunca chega a ser contado — quem varre token tinha
 * verificação de assinatura à vontade, sem teto nenhum.
 *
 * **Conta a recusa, e não a requisição.** Um teto pré-autenticação sobre todo o tráfego
 * precisaria de uma chave que identificasse quem chama, e o IP não identifica: o Portal
 * web chega pelo servidor do Next, um IP só para todos os tutores de um petshop. Tráfego
 * legítimo não apresenta token inválido em série; varredura, sim. E token **ausente** não
 * conta — é quem saiu da sessão, e não custa verificação nenhuma.
 *
 * A memória é do processo, como o balde do `@fastify/rate-limit` registrado no `app.ts`:
 * com duas réplicas o teto efetivo dobra, o que para este propósito basta.
 */

export interface AuthFailureGuard {
  /** `true` quando a chave estourou o teto na janela corrente. Não conta nada. */
  isBlocked: (key: string) => boolean
  /** Soma uma recusa à chave. */
  record: (key: string) => void
}

interface Window {
  count: number
  resetAt: number
}

export function createAuthFailureGuard(options: {
  max: number
  windowMs: number
  /** Teto de chaves em memória: uma varredura de IPs não pode encher o processo. */
  maxKeys?: number
  now?: () => number
}): AuthFailureGuard {
  const { max, windowMs, maxKeys = 10_000, now = Date.now } = options
  const windows = new Map<string, Window>()

  function abrir(key: string, at: number): void {
    if (windows.size >= maxKeys) {
      for (const [k, w] of windows) if (w.resetAt <= at) windows.delete(k)
      // Ainda cheio: sai a mais antiga, que o `Map` guarda em ordem de inserção.
      if (windows.size >= maxKeys) {
        const oldest = windows.keys().next().value
        if (oldest !== undefined) windows.delete(oldest)
      }
    }
    windows.set(key, { count: 1, resetAt: at + windowMs })
  }

  return {
    isBlocked(key) {
      const window = windows.get(key)
      return window !== undefined && window.resetAt > now() && window.count >= max
    },
    record(key) {
      const at = now()
      const window = windows.get(key)
      if (!window || window.resetAt <= at) {
        windows.delete(key)
        abrir(key, at)
        return
      }
      window.count += 1
    },
  }
}
