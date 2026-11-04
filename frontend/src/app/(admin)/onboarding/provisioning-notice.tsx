'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui'

/**
 * AC-03 de MOD-IDENT-01 — a tela de "estamos finalizando sua conta".
 *
 * O tenant existe e nada foi perdido; falta só a etapa externa, que o job
 * `tenant-provisioning-retry` retoma a cada 2 minutos. A página se recarrega sozinha
 * para não exigir que o usuário fique apertando F5.
 */
export function ProvisioningNotice({ status }: { status: string }) {
  const router = useRouter()
  const failed = status === 'PROVISIONING_FAILED'

  useEffect(() => {
    if (failed) return
    const timer = setInterval(() => router.refresh(), 15_000)
    return () => clearInterval(timer)
  }, [failed, router])

  return (
    <Card className="max-w-lg text-center">
      {failed ? (
        <>
          <h1 className="text-3xl font-light leading-[1.1] tracking-[-0.035em] sm:text-[38px]">
            Precisamos de Mais um <span className="aurora-text font-semibold">Instante</span>
          </h1>
          <p className="hint mt-3">
            Houve um problema ao finalizar seu cadastro e nossa equipe já foi avisada. Seus dados
            estão salvos — assim que resolvermos, você recebe um e-mail para continuar.
          </p>
        </>
      ) : (
        <>
          <div className="mx-auto mb-5 h-10 w-10 animate-spin rounded-full border-2 border-line border-t-accent" />
          <h1 className="text-3xl font-light leading-[1.1] tracking-[-0.035em] sm:text-[38px]">
            Estamos Finalizando Sua <span className="aurora-text font-semibold">Conta</span>
          </h1>
          <p className="hint mt-3">
            Leva menos de um minuto. Esta página se atualiza sozinha quando estiver pronta.
          </p>
        </>
      )}
    </Card>
  )
}
