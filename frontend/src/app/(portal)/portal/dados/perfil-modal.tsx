'use client'

import { useState, useTransition } from 'react'
import type { PortalMeDataResponse, PortalProfile } from '@petshop/shared-types'
import { Field, FormError } from '@/components/ui'
import { Modal } from '@/components/modal'
import { IdCardIcon } from '@/components/icons'
import { salvarPerfil } from './actions'

/**
 * Os dois campos que o tutor muda sozinho.
 *
 * `icon-people` é o tom do domínio Tutores no menu do Admin (regra 3 do padrão de
 * formulários). O Portal não tem menu lateral, mas a paleta é a mesma do produto — e o dia
 * em que o tutor vir a própria ficha do outro lado do balcão, as duas vão combinar.
 *
 * **Nome completo, CPF e contato não estão aqui, nem desabilitados.** Os dois primeiros são
 * conferidos com documento no balcão; o contato tem caminho próprio, com código. Campo
 * desabilitado é convite a tentar.
 */
export function PerfilModal({
  perfil,
  onSalvo,
}: {
  perfil: PortalProfile
  onSalvo: (dados: PortalMeDataResponse) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [social, setSocial] = useState(perfil.socialName ?? '')
  const [nascimento, setNascimento] = useState(perfil.birthDate ?? '')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, startTransition] = useTransition()

  function abrir() {
    setSocial(perfil.socialName ?? '')
    setNascimento(perfil.birthDate ?? '')
    setErro(null)
    setAberto(true)
  }

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)

    startTransition(async () => {
      const resultado = await salvarPerfil({
        // String vazia é o "apagar" do campo, e vira `null` — omitir manteria o valor
        // antigo, que é o contrário do que quem limpou o campo pediu.
        socialName: social.trim() === '' ? null : social.trim(),
        birthDate: nascimento === '' ? null : nascimento,
      })
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setAberto(false)
      onSalvo(resultado)
    })
  }

  return (
    <>
      <button type="button" className="btn btn-ghost h-9" onClick={abrir}>
        Editar
      </button>

      <Modal
        open={aberto}
        onClose={() => setAberto(false)}
        busy={salvando}
        icon={<IdCardIcon />}
        tone="icon-people"
        eyebrow="Cadastro"
        title="Seus dados"
        subtitle="Nome completo e documento são atualizados pelo estabelecimento."
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAberto(false)}
              disabled={salvando}
            >
              Cancelar
            </button>
            <button
              type="submit"
              form="portal-perfil-form"
              className="btn btn-primary"
              disabled={salvando}
            >
              {salvando ? 'Salvando…' : 'Salvar'}
            </button>
          </>
        }
      >
        <form id="portal-perfil-form" className="flex flex-col gap-5" onSubmit={enviar} noValidate>
          <FormError message={erro} />

          <Field
            label="Como prefere ser chamado"
            htmlFor="perfil-social"
            hint="É este nome que aparece nas nossas mensagens e no atendimento."
          >
            <input
              id="perfil-social"
              className="field"
              value={social}
              onChange={(event) => setSocial(event.target.value)}
              maxLength={120}
              placeholder={primeiroNome(perfil.fullName)}
            />
          </Field>

          <Field
            label="Data de nascimento"
            htmlFor="perfil-nascimento"
            hint="Opcional. Serve só para lembrarmos da sua data."
          >
            <input
              id="perfil-nascimento"
              type="date"
              className="field"
              value={nascimento}
              max={hoje()}
              onChange={(event) => setNascimento(event.target.value)}
            />
          </Field>
        </form>
      </Modal>
    </>
  )
}

function primeiroNome(nome: string): string {
  return nome.split(' ')[0] ?? nome
}

function hoje(): string {
  return new Date().toISOString().slice(0, 10)
}
