'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { SignOutButton } from '@clerk/nextjs'
import { Alert, Card, Field, FormActions, FormError, SectionHead } from '@/components/ui'
import { IdCardIcon, ShieldCheckIcon } from '@/components/icons'
import { confirmarCodigo, pedirCodigo } from './actions'

/**
 * O vínculo, em dois passos: o contato e o código.
 *
 * O formulário **não** diz se o contato foi encontrado, e isso não é omissão: a
 * resposta do serviço é idêntica para quem é cliente e para quem não é (RN-04), porque
 * o contrário transformaria a tela num consultor de "fulano é cliente daqui?". Quem
 * digitou um contato errado descobre no passo dois, quando o código não chega — e a
 * tela oferece voltar.
 *
 * O honeypot é um campo de verdade no HTML, escondido do olho e do leitor de tela, com
 * nome inócuo. Gente nunca o preenche; robô que varre formulário preenche tudo.
 */

type Etapa =
  | { nome: 'contato' }
  | { nome: 'codigo'; challengeId: string; maskedTarget: string }

export function LinkForm() {
  const router = useRouter()
  const [etapa, setEtapa] = useState<Etapa>({ nome: 'contato' })
  const [identifier, setIdentifier] = useState('')
  const [honeypot, setHoneypot] = useState('')
  const [code, setCode] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, startTransition] = useTransition()

  function enviarContato(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)
    startTransition(async () => {
      const result = await pedirCodigo(identifier, honeypot)
      if (!result.ok) {
        setErro(result.message)
        return
      }
      setEtapa({
        nome: 'codigo',
        challengeId: result.challengeId,
        maskedTarget: result.maskedTarget,
      })
    })
  }

  function enviarCodigo(event: React.FormEvent) {
    event.preventDefault()
    if (etapa.nome !== 'codigo') return
    setErro(null)
    startTransition(async () => {
      const result = await confirmarCodigo(etapa.challengeId, code)
      if (!result.ok) {
        setErro(result.message)
        return
      }
      router.replace('/portal/inicio')
      router.refresh()
    })
  }

  if (etapa.nome === 'codigo') {
    return (
      <Card tone="soft">
        <form className="flex flex-col gap-5" onSubmit={enviarCodigo}>
          <SectionHead
            icon={<ShieldCheckIcon />}
            tone="icon-people"
            title="Digite o código"
            description={`Enviamos um código de 6 dígitos para ${etapa.maskedTarget}. Ele vale por 10 minutos.`}
          />

          <Field label="Código" htmlFor="code">
            <input
              id="code"
              className="field text-center text-lg tracking-[0.4em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              required
            />
          </Field>

          <FormError message={erro} />

          <FormActions>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setEtapa({ nome: 'contato' })
                setCode('')
                setErro(null)
              }}
            >
              Usar outro contato
            </button>
            <button type="submit" className="btn btn-primary" disabled={enviando || code.length < 6}>
              {enviando ? 'Confirmando…' : 'Confirmar'}
            </button>
          </FormActions>
        </form>
      </Card>
    )
  }

  return (
    <Card tone="soft">
      <form className="flex flex-col gap-5" onSubmit={enviarContato}>
        <SectionHead
          icon={<IdCardIcon />}
          tone="icon-people"
          title="Encontre o seu cadastro"
          description="Informe o e-mail ou o telefone que você já deu ao estabelecimento."
        />

        <Field
          label="E-mail ou telefone"
          htmlFor="identifier"
          hint="É o mesmo contato que eles usam para falar com você."
        >
          <input
            id="identifier"
            className="field"
            autoComplete="email tel"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            required
          />
        </Field>

        {/*
          Honeypot. Fora do fluxo do leitor de tela (`aria-hidden` mais `tabIndex={-1}`)
          e fora do olho, mas presente no HTML: é o campo que separa gente de robô.
        */}
        <div aria-hidden="true" className="absolute h-0 w-0 overflow-hidden opacity-0">
          <label htmlFor="website">Site</label>
          <input
            id="website"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(event) => setHoneypot(event.target.value)}
          />
        </div>

        <FormError message={erro} />

        <Alert tone="accent" icon={<ShieldCheckIcon />} title="Só quem já é cliente entra" role="status">
          O acesso é criado sobre o cadastro que o estabelecimento já tem. Se o contato não
          for encontrado, o código não chega — e aí é com eles que você fala.
        </Alert>

        {/*
          A saída desta tela, no molde do aceite de convite do Admin.
          Quem entrou com a conta errada não tem ficha para vincular e não tem para onde
          ir: o Início, que é onde mora o "Sair", exige justamente o vínculo que falta.
          Sem este botão a tela é uma armadilha.
        */}
        <FormActions>
          <SignOutButton redirectUrl="/portal/entrar">
            <button type="button" className="btn btn-ghost" disabled={enviando}>
              Entrar com outra conta
            </button>
          </SignOutButton>
          <button type="submit" className="btn btn-primary" disabled={enviando}>
            {enviando ? 'Enviando…' : 'Enviar código'}
          </button>
        </FormActions>
      </form>
    </Card>
  )
}
