'use client'

import { useState, useTransition } from 'react'
import type {
  PortalContactField,
  PortalMeDataResponse,
  PortalProfile,
} from '@petshop/shared-types'
import { Field, FormError, Segmented } from '@/components/ui'
import { Modal } from '@/components/modal'
import { PhoneIcon } from '@/components/icons'
import { confirmarContato, pedirCodigoContato } from './actions'

/**
 * A troca de telefone ou e-mail, em dois passos (AC-02 de MOD-PORTAL-09).
 *
 * **Um diálogo, duas vistas, e não duas telas.** A pessoa sai do navegador para ler a
 * mensagem e volta; se o segundo passo fosse uma página, voltar exigiria refazer o
 * caminho. O `onBack` do `<Modal>` desenha a seta que retoma o passo anterior — que aqui
 * significa "digitei o número errado", o motivo número um de o código nunca chegar.
 *
 * **A vista de código abre sozinha quando há um pedido pendente.** O servidor devolve o
 * desafio aberto em `pendingContact` justamente para isto: quem recarregou a página no meio
 * da verificação encontra o campo do código, e não um formulário vazio com um desafio
 * fantasma esperando expirar.
 *
 * O que a tela **não** faz: aplicar a mudança antes do código. O telefone só entra na ficha
 * depois que o servidor confere o que chegou ao aparelho — a tela não tem como adiantar
 * isso, e não deve dar a impressão de que teve.
 */
export function ContatoModal({
  perfil,
  pendente,
  onSalvo,
}: {
  perfil: PortalProfile
  pendente: PortalMeDataResponse['pendingContact']
  onSalvo: (dados: PortalMeDataResponse) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [campo, setCampo] = useState<PortalContactField>(pendente?.field ?? 'PHONE')
  const [valor, setValor] = useState('')
  const [codigo, setCodigo] = useState('')
  const [desafio, setDesafio] = useState<{ id: string; destino: string } | null>(
    pendente ? { id: pendente.id, destino: pendente.maskedTarget } : null,
  )
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, startTransition] = useTransition()

  function abrir() {
    setErro(null)
    setCodigo('')
    setValor('')
    setCampo(pendente?.field ?? 'PHONE')
    setDesafio(pendente ? { id: pendente.id, destino: pendente.maskedTarget } : null)
    setAberto(true)
  }

  function voltarParaOValor() {
    setDesafio(null)
    setCodigo('')
    setErro(null)
  }

  function pedirCodigo(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)

    startTransition(async () => {
      const resultado = await pedirCodigoContato({ field: campo, value: valor.trim() })
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setDesafio({ id: resultado.changeId, destino: resultado.maskedTarget })
    })
  }

  function confirmar(event: React.FormEvent) {
    event.preventDefault()
    if (!desafio) return
    setErro(null)

    startTransition(async () => {
      const resultado = await confirmarContato({ changeId: desafio.id, code: codigo })
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setAberto(false)
      setDesafio(null)
      setCodigo('')
      onSalvo(resultado)
    })
  }

  const rotuloCampo = campo === 'PHONE' ? 'telefone' : 'e-mail'

  return (
    <>
      <button type="button" className="btn btn-ghost h-9" onClick={abrir}>
        {pendente ? 'Confirmar' : 'Alterar'}
      </button>

      <Modal
        open={aberto}
        onClose={() => setAberto(false)}
        busy={ocupado}
        icon={<PhoneIcon />}
        tone="icon-people"
        eyebrow="Contato"
        title={desafio ? 'Confirme o código' : 'Alterar contato'}
        subtitle={
          desafio
            ? `Enviamos um código para ${desafio.destino}. Ele vale por 10 minutos.`
            : 'Enviaremos um código para o contato novo antes de trocar.'
        }
        onBack={desafio && !pendente ? voltarParaOValor : undefined}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAberto(false)}
              disabled={ocupado}
            >
              Cancelar
            </button>
            {desafio ? (
              <button
                type="submit"
                form="portal-contato-codigo"
                className="btn btn-primary"
                disabled={ocupado || codigo.length !== 6}
              >
                {ocupado ? 'Confirmando…' : 'Confirmar'}
              </button>
            ) : (
              <button
                type="submit"
                form="portal-contato-valor"
                className="btn btn-primary"
                disabled={ocupado || valor.trim().length < 5}
              >
                {ocupado ? 'Enviando…' : 'Enviar código'}
              </button>
            )}
          </>
        }
      >
        {desafio ? (
          <form
            id="portal-contato-codigo"
            className="flex flex-col gap-5"
            onSubmit={confirmar}
            noValidate
          >
            <FormError message={erro} />

            <Field label="Código de 6 dígitos" htmlFor="contato-codigo">
              <input
                id="contato-codigo"
                className="field"
                value={codigo}
                // `inputMode` e não `type="number"`: o teclado numérico do celular sem o
                // seletor de incremento, que num código de acesso não faz sentido nenhum.
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                onChange={(event) => setCodigo(event.target.value.replace(/\D/g, ''))}
                required
              />
            </Field>

            <p className="hint">
              Não recebeu? Volte, confira o {rotuloCampo} digitado e peça de novo.
            </p>
          </form>
        ) : (
          <form
            id="portal-contato-valor"
            className="flex flex-col gap-5"
            onSubmit={pedirCodigo}
            noValidate
          >
            <FormError message={erro} />

            <Segmented
              options={[
                { value: 'PHONE', label: 'Telefone' },
                { value: 'EMAIL', label: 'E-mail' },
              ]}
              value={campo}
              onChange={(proximo) => {
                setCampo(proximo)
                setValor('')
                setErro(null)
              }}
              disabled={ocupado}
              ariaLabel="O que você quer alterar"
            />

            <Field
              label={campo === 'PHONE' ? 'Telefone novo' : 'E-mail novo'}
              htmlFor="contato-valor"
              hint={
                campo === 'PHONE'
                  ? `Hoje: ${perfil.phoneMasked}. Informe DDD e número.`
                  : perfil.email
                    ? `Hoje: ${perfil.email}`
                    : 'Você ainda não tem e-mail cadastrado.'
              }
            >
              <input
                id="contato-valor"
                className="field"
                value={valor}
                type={campo === 'EMAIL' ? 'email' : 'tel'}
                inputMode={campo === 'EMAIL' ? 'email' : 'tel'}
                autoComplete={campo === 'EMAIL' ? 'email' : 'tel'}
                maxLength={160}
                onChange={(event) => setValor(event.target.value)}
                required
              />
            </Field>
          </form>
        )}
      </Modal>
    </>
  )
}
