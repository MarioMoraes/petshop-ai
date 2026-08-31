'use client'

import { useState, useTransition } from 'react'
import { submitLeadAction, type LeadFormState } from './actions'
import type { SitePalette } from './branding'

/**
 * O formulário de contato (MOD-SITE-08).
 *
 * **O campo `website` é o honeypot**: escondido por CSS e fora da ordem de tabulação,
 * nenhuma pessoa o vê e todo bot o preenche. Quando chega preenchido, o serviço
 * responde 201 sem gravar nada — e esta tela mostra a mesma confirmação de sempre.
 * Mostrar erro ensinaria o bot a contornar.
 *
 * O aviso de finalidade fica **no envio**, e não escondido num link: quem manda o
 * telefone tem direito de saber para que ele vai ser usado e por quanto tempo fica.
 */

export function LeadForm({ slug, palette }: { slug: string; palette: SitePalette }) {
  const [state, setState] = useState<LeadFormState | null>(null)
  const [pending, startTransition] = useTransition()

  function errorFor(field: string): string | undefined {
    return state?.fieldErrors?.find((error) => error.field === field)?.message
  }

  if (state?.ok) {
    return (
      <div
        className="rounded-3xl border p-8 text-center"
        style={{ backgroundColor: palette.tint, borderColor: palette.line }}
      >
        <p className="text-lg font-semibold text-ink">Recebemos sua mensagem.</p>
        <p className="mt-2 text-sm text-muted">
          A gente entra em contato pelo telefone que você deixou.
        </p>
      </div>
    )
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        const data = Object.fromEntries(new FormData(event.currentTarget))
        startTransition(async () => {
          setState(await submitLeadAction(slug, data))
        })
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Seu nome" name="name" error={errorFor('name')} autoComplete="name" required />
        <Field
          label="Telefone ou WhatsApp"
          name="phone"
          error={errorFor('phone')}
          autoComplete="tel"
          inputMode="tel"
          required
        />
      </div>

      <Field
        label="E-mail (opcional)"
        name="email"
        type="email"
        error={errorFor('email')}
        autoComplete="email"
      />

      <label className="grid gap-1.5">
        <span className="text-sm font-medium text-ink">Como podemos ajudar?</span>
        <textarea
          name="message"
          rows={4}
          className="w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none focus-visible:border-transparent"
          style={{ ['--tw-ring-color' as string]: palette.brand }}
          placeholder="Quero marcar um banho para o meu cachorro no sábado"
        />
        {errorFor('message') ? (
          <span className="text-xs text-danger">{errorFor('message')}</span>
        ) : null}
      </label>

      {/*
        Honeypot. `aria-hidden` e `tabIndex={-1}` mantêm-no fora do alcance de quem usa
        leitor de tela ou teclado; `autoComplete="off"` impede o gerenciador de senhas
        de preenchê-lo por engano e transformar uma pessoa em bot.
      */}
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label>
          Site
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      {state?.message ? (
        <p className="text-sm" style={{ color: state.throttled ? '#4b4d52' : '#b4231b' }}>
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full px-6 py-3 text-sm font-semibold transition disabled:opacity-60"
          style={{ backgroundColor: palette.brand, color: palette.onBrand }}
        >
          {pending ? 'Enviando…' : 'Enviar mensagem'}
        </button>
        {/*
          O aviso de finalidade fica **no envio**, e não escondido num link: quem manda
          o telefone tem direito de saber para que ele vai ser usado e por quanto tempo
          fica. `text-muted` e não `text-subtle` — o cinza mais claro reprova o AA da
          WCAG, e este é justamente um texto que precisa ser lido.
        */}
        <p className="text-xs text-muted">
          Usamos seu contato só para responder esta mensagem. Sem retorno, apagamos em 12 meses.
        </p>
      </div>
    </form>
  )
}

function Field({
  label,
  name,
  error,
  ...props
}: {
  label: string
  name: string
  error?: string | undefined
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      <input
        {...props}
        name={name}
        className="w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none"
      />
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </label>
  )
}
