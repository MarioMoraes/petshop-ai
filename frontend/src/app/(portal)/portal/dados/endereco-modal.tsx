'use client'

import { useState, useTransition } from 'react'
import type { PortalAddress, PortalMeDataResponse } from '@petshop/shared-types'
import { Choice, Field, FormError } from '@/components/ui'
import { Modal } from '@/components/modal'
import { MapPinIcon } from '@/components/icons'
import { corrigirEndereco, salvarEndereco } from './actions'

/**
 * O endereço, cadastrado ou corrigido pelo titular (AC-01).
 *
 * Um componente para os dois casos, e não dois: os campos são os mesmos, e a única
 * diferença é o verbo. Duplicá-lo faria a validação envelhecer em um dos dois.
 *
 * **Sem latitude e longitude**, nem escondidas: quem geocodifica é o MOD-TAXI, e aceitar
 * coordenadas do cliente deixaria o tutor mover o ponto de coleta da van para qualquer
 * lugar do mapa sem mudar uma letra do endereço. O servidor recusa; a tela nem oferece.
 */
export function EnderecoModal({
  endereco,
  onSalvo,
}: {
  endereco?: PortalAddress
  onSalvo: (dados: PortalMeDataResponse) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [form, setForm] = useState(() => vazio(endereco))
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, startTransition] = useTransition()

  function abrir() {
    setForm(vazio(endereco))
    setErro(null)
    setAberto(true)
  }

  function campo<K extends keyof Formulario>(chave: K, valor: Formulario[K]) {
    setForm((atual) => ({ ...atual, [chave]: valor }))
  }

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)

    const payload = {
      label: form.label.trim() || 'Casa',
      zipCode: form.zipCode.replace(/\D/g, ''),
      street: form.street.trim(),
      number: form.number.trim(),
      ...(form.complement.trim() ? { complement: form.complement.trim() } : {}),
      district: form.district.trim(),
      city: form.city.trim(),
      state: form.state.trim().toUpperCase(),
      ...(form.accessNotes.trim() ? { accessNotes: form.accessNotes.trim() } : {}),
      isPrimary: form.isPrimary,
    }

    startTransition(async () => {
      const resultado = endereco
        ? await corrigirEndereco(endereco.id, payload)
        : await salvarEndereco(payload)

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
        {endereco ? 'Editar' : 'Adicionar'}
      </button>

      <Modal
        open={aberto}
        onClose={() => setAberto(false)}
        busy={salvando}
        icon={<MapPinIcon />}
        tone="icon-people"
        eyebrow="Endereço"
        title={endereco ? 'Corrigir endereço' : 'Novo endereço'}
        subtitle="É por ele que a van encontra você no leva-e-traz."
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
              form="portal-endereco-form"
              className="btn btn-primary"
              disabled={salvando}
            >
              {salvando ? 'Salvando…' : 'Salvar'}
            </button>
          </>
        }
      >
        <form
          id="portal-endereco-form"
          className="flex flex-col gap-5"
          onSubmit={enviar}
          noValidate
        >
          <FormError message={erro} />

          <Field label="Apelido" htmlFor="end-label" hint="Casa, trabalho, casa da minha mãe…">
            <input
              id="end-label"
              className="field"
              value={form.label}
              onChange={(event) => campo('label', event.target.value)}
              maxLength={40}
              placeholder="Casa"
            />
          </Field>

          <Field label="CEP" htmlFor="end-cep">
            <input
              id="end-cep"
              className="field"
              value={form.zipCode}
              inputMode="numeric"
              maxLength={9}
              onChange={(event) => campo('zipCode', event.target.value)}
              required
            />
          </Field>

          <Field label="Rua" htmlFor="end-rua">
            <input
              id="end-rua"
              className="field"
              value={form.street}
              onChange={(event) => campo('street', event.target.value)}
              maxLength={160}
              required
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Número" htmlFor="end-numero">
              <input
                id="end-numero"
                className="field"
                value={form.number}
                onChange={(event) => campo('number', event.target.value)}
                maxLength={20}
                required
              />
            </Field>

            <Field label="Complemento" htmlFor="end-complemento">
              <input
                id="end-complemento"
                className="field"
                value={form.complement}
                onChange={(event) => campo('complement', event.target.value)}
                maxLength={80}
              />
            </Field>
          </div>

          <Field label="Bairro" htmlFor="end-bairro">
            <input
              id="end-bairro"
              className="field"
              value={form.district}
              onChange={(event) => campo('district', event.target.value)}
              maxLength={80}
              required
            />
          </Field>

          <div className="grid grid-cols-[1fr_5rem] gap-4">
            <Field label="Cidade" htmlFor="end-cidade">
              <input
                id="end-cidade"
                className="field"
                value={form.city}
                onChange={(event) => campo('city', event.target.value)}
                maxLength={80}
                required
              />
            </Field>

            <Field label="UF" htmlFor="end-uf">
              <input
                id="end-uf"
                className="field"
                value={form.state}
                onChange={(event) => campo('state', event.target.value.toUpperCase())}
                maxLength={2}
                required
              />
            </Field>
          </div>

          <Field
            label="Como chegar"
            htmlFor="end-acesso"
            hint="Portão azul, chamar no interfone 12, cachorro solto no quintal…"
          >
            <textarea
              id="end-acesso"
              className="field"
              rows={2}
              value={form.accessNotes}
              onChange={(event) => campo('accessNotes', event.target.value)}
              maxLength={300}
            />
          </Field>

          <Choice
            label="Usar como endereço principal"
            description="É o que a van usa quando você pede o leva-e-traz."
            checked={form.isPrimary}
            onChange={(valor) => campo('isPrimary', valor)}
          />
        </form>
      </Modal>
    </>
  )
}

interface Formulario {
  label: string
  zipCode: string
  street: string
  number: string
  complement: string
  district: string
  city: string
  state: string
  accessNotes: string
  isPrimary: boolean
}

function vazio(endereco?: PortalAddress): Formulario {
  return {
    label: endereco?.label ?? '',
    zipCode: endereco?.zipCode ?? '',
    street: endereco?.street ?? '',
    number: endereco?.number ?? '',
    complement: endereco?.complement ?? '',
    district: endereco?.district ?? '',
    city: endereco?.city ?? '',
    state: endereco?.state ?? '',
    accessNotes: endereco?.accessNotes ?? '',
    // O primeiro endereço nasce principal: exigir o clique deixaria a ficha com um
    // endereço e nenhum principal, que é o estado que o leva-e-traz não sabe resolver.
    isPrimary: endereco?.isPrimary ?? true,
  }
}
