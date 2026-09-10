'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { PortalPetDetail, UpdateOwnPetInput } from '@petshop/shared-types'
import { Button, Field, FormError, Segmented } from '@/components/ui'
import { Modal } from '@/components/modal'
import { PawPrintIcon } from '@/components/icons'
import { salvarPet } from './actions'

/**
 * A edição da ficha pelo tutor.
 *
 * É `<Modal>`, e não uma página `/editar`: o formulário responde a **um** registro que
 * já está na tela, e a regra 8 de `docs/design-formularios.md` é exatamente esse caso.
 * No celular ele vira folha inferior, colada no rodapé, com os botões na largura toda.
 *
 * Quatro campos, e o motivo de serem quatro está no PRD: peso, porte, raça e pelagem
 * entram no preço, então não estão aqui — nem desabilitados. Campo desabilitado num
 * formulário é convite a tentar; o que não se edita fica na ficha, como leitura, com a
 * frase que explica por quê.
 *
 * O tom do chip é `icon-pet`, o do domínio Pets no menu do Admin (regra 3). O Portal não
 * tem menu lateral, mas a paleta é a mesma do produto — e o dia em que o tutor vir uma
 * tela de pet do outro lado, as duas vão combinar.
 */
export function PetForm({ pet }: { pet: PortalPetDetail }) {
  const router = useRouter()
  const [aberto, setAberto] = useState(false)
  const [nome, setNome] = useState(pet.name)
  const [nascimento, setNascimento] = useState(pet.birthDate ?? '')
  const [castrado, setCastrado] = useState<'SIM' | 'NAO' | 'NAO_SEI'>(ternario(pet.neutered))
  const [observacoes, setObservacoes] = useState(pet.notes ?? '')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, startTransition] = useTransition()

  function fechar() {
    setAberto(false)
    setErro(null)
  }

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)

    const input: UpdateOwnPetInput = {
      name: nome.trim(),
      // String vazia é o "apagar" do campo, e vira `null` — omitir manteria o valor
      // antigo, que é o contrário do que quem limpou o campo pediu.
      birthDate: nascimento === '' ? null : nascimento,
      neutered: castrado === 'NAO_SEI' ? null : castrado === 'SIM',
      notes: observacoes.trim() === '' ? null : observacoes.trim(),
    }

    startTransition(async () => {
      const resultado = await salvarPet(pet.id, input)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setAberto(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" variant="ghost" className="h-9" onClick={() => setAberto(true)}>
        Editar
      </Button>

      <Modal
        open={aberto}
        onClose={fechar}
        busy={salvando}
        icon={<PawPrintIcon />}
        tone="icon-pet"
        eyebrow="Ficha"
        title={`Dados do ${pet.name}`}
        subtitle="Peso, porte, raça e pelagem são atualizados pelo estabelecimento."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={fechar} disabled={salvando}>
              Cancelar
            </Button>
            <Button
              type="submit"
              form="portal-pet-form"
              busy={salvando}
              disabled={nome.trim() === ''}
              busyLabel="Salvando…"
            >
              Salvar
            </Button>
          </>
        }
      >
        <form id="portal-pet-form" className="flex flex-col gap-5" onSubmit={enviar} noValidate>
          <Field label="Nome" htmlFor="pet-nome">
            <input
              id="pet-nome"
              className="field"
              value={nome}
              onChange={(event) => setNome(event.target.value)}
              maxLength={60}
              required
            />
          </Field>

          <Field
            label="Data de nascimento"
            htmlFor="pet-nascimento"
            hint="Se não souber o dia exato, deixe em branco — o estabelecimento estima pela idade."
          >
            <input
              id="pet-nascimento"
              type="date"
              className="field"
              value={nascimento}
              max={hoje()}
              onChange={(event) => setNascimento(event.target.value)}
            />
          </Field>

          {/*
            O `Segmented` fica fora de um `Field`: ele é um grupo de botões, não um
            campo, e um `<label htmlFor>` apontando para nada quebra o leitor de tela.
            O rótulo visível é `.label`, e quem anuncia o grupo é o `ariaLabel`.
          */}
          <div>
            <p className="label">Castrado</p>
            <Segmented
              ariaLabel="Castrado"
              value={castrado}
              onChange={setCastrado}
              options={[
                { value: 'SIM', label: 'Sim' },
                { value: 'NAO', label: 'Não' },
                { value: 'NAO_SEI', label: 'Não sei' },
              ]}
            />
          </div>

          <Field
            label="Observações"
            htmlFor="pet-observacoes"
            hint="O que ajuda quem vai atender: manias, medos, o que acalma."
          >
            <textarea
              id="pet-observacoes"
              className="field min-h-24"
              value={observacoes}
              onChange={(event) => setObservacoes(event.target.value)}
              maxLength={500}
            />
          </Field>

          <FormError message={erro} />
        </form>
      </Modal>
    </>
  )
}

function ternario(valor: boolean | null): 'SIM' | 'NAO' | 'NAO_SEI' {
  if (valor === null) return 'NAO_SEI'
  return valor ? 'SIM' : 'NAO'
}

function hoje(): string {
  return new Date().toISOString().slice(0, 10)
}
