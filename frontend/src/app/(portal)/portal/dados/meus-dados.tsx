'use client'

import { useState } from 'react'
import type { PortalMeDataResponse } from '@petshop/shared-types'
import { Alert, Card, DataRow, SectionHead } from '@/components/ui'
import {
  AlertTriangleIcon,
  DocumentIcon,
  IdCardIcon,
  MapPinIcon,
  PhoneIcon,
} from '@/components/icons'
import { RowChip, RowItem, RowStack, RowText } from '../list'
import { ContatoModal } from './contato-modal'
import { EnderecoModal } from './endereco-modal'
import { Exclusao } from './exclusao'
import { PerfilModal } from './perfil-modal'

/**
 * A casca de Meus Dados.
 *
 * **Um estado só, no topo, e todas as ações o substituem.** Cada rota de escrita do BFF
 * devolve a ficha inteira relida, e é ela que passa a valer — a tela nunca remenda o que
 * tinha com o que supôs ter salvado. É a mesma escolha do interruptor de preferências do
 * MOD-PORTAL-10, e pela mesma razão: um dado que parece salvo e não está faz a pessoa
 * fechar o navegador confiando no que leu.
 *
 * Os cartões são **brancos**, e não `tone="soft"`: aqui não há campo nenhum: o que se vê é
 * leitura, e cada edição abre em `<Modal>` (regra 1 e regra 8 de
 * `docs/design-formularios.md`). No celular o diálogo vira folha inferior.
 *
 * Cada seção abre com `<SectionHead>` e o chip do assunto, como o resto do Portal passou
 * a fazer em 2026-09-08: o olho-de-boi sozinho identificava a seção, mas não dava a ela
 * peso nenhum na página — quatro cartões brancos seguidos liam como um documento longo
 * em vez de quatro assuntos.
 */
export function MeusDados({
  inicial,
  tenantName,
  falhaNaExportacao = false,
}: {
  inicial: PortalMeDataResponse
  tenantName: string
  /** A rota de download desvia para cá quando não consegue montar o arquivo. */
  falhaNaExportacao?: boolean
}) {
  const [dados, setDados] = useState(inicial)

  return (
    <>
      {falhaNaExportacao && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="Não foi possível baixar agora">
          Tente de novo em alguns instantes. Se continuar, fale com o {tenantName}.
        </Alert>
      )}

      <Card>
        <div className="flex items-start justify-between gap-3">
          <SectionHead icon={<IdCardIcon />} tone="icon-people" title="Seus dados" />
          <PerfilModal perfil={dados.profile} onSalvo={setDados} />
        </div>

        <div className="mt-4 flex flex-col gap-1">
          <DataRow label="Nome">{dados.profile.fullName}</DataRow>
          {dados.profile.socialName && (
            <DataRow label="Como prefere ser chamado">{dados.profile.socialName}</DataRow>
          )}
          {dados.profile.cpfMasked && <DataRow label="CPF">{dados.profile.cpfMasked}</DataRow>}
          {dados.profile.cnpjMasked && <DataRow label="CNPJ">{dados.profile.cnpjMasked}</DataRow>}
          {dados.profile.birthDate && (
            <DataRow label="Nascimento">{porExtenso(dados.profile.birthDate)}</DataRow>
          )}
        </div>

        {/*
          A frase que explica a ausência dos campos, em vez de mostrá-los desabilitados.
          Campo desabilitado num formulário é convite a tentar; o que não se edita fica na
          ficha como leitura, com o motivo ao lado — a mesma escolha da ficha do pet.
        */}
        <p className="hint mt-4">
          Nome completo e documento são conferidos no balcão. Se algum estiver errado, avise o{' '}
          {tenantName}.
        </p>
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-3">
          <SectionHead icon={<PhoneIcon />} tone="icon-brand" title="Contato" />
          <ContatoModal perfil={dados.profile} pendente={dados.pendingContact} onSalvo={setDados} />
        </div>

        <div className="mt-4 flex flex-col gap-1">
          <DataRow label="Telefone">{dados.profile.phoneMasked}</DataRow>
          <DataRow label="E-mail">{dados.profile.email ?? 'Não cadastrado'}</DataRow>
        </div>

        <p className="hint mt-4">
          Trocar telefone ou e-mail pede um código enviado ao contato novo. É como sabemos que é
          você — e é o que impede alguém de apontar o seu cadastro para outro número.
        </p>
      </Card>

      <RowStack
        head={
          <div className="flex items-start justify-between gap-3">
            <SectionHead
              icon={<MapPinIcon />}
              tone="icon-time"
              title="Endereços"
              description={
                dados.addresses.length === 0
                  ? 'Nenhum endereço cadastrado. Ele é usado no leva-e-traz e nas entregas.'
                  : undefined
              }
            />
            <EnderecoModal onSalvo={setDados} />
          </div>
        }
      >
        {dados.addresses.map((endereco) => (
          <RowItem key={endereco.id} top>
            <RowChip icon={<MapPinIcon />} tone="icon-time" />

            <RowText
              title={
                <>
                  {endereco.label}
                  {endereco.isPrimary && (
                    <span className="section-eyebrow ml-2 align-middle">Principal</span>
                  )}
                </>
              }
              hint={
                <>
                  {endereco.street}, {endereco.number}
                  {endereco.complement ? ` — ${endereco.complement}` : ''}
                </>
              }
            >
              <span className="hint block">
                {endereco.district} · {endereco.city}/{endereco.state} · {cep(endereco.zipCode)}
              </span>
            </RowText>

            <span className="shrink-0">
              <EnderecoModal endereco={endereco} onSalvo={setDados} />
            </span>
          </RowItem>
        ))}
      </RowStack>

      <Card>
        <SectionHead
          icon={<DocumentIcon />}
          tone="icon-system"
          title="Uma cópia dos seus dados"
          description={`Baixe tudo o que o ${tenantName} tem sobre você, num documento só. É um direito seu, e não precisa de pedido nem de espera.`}
        />
        {/*
          `<a download>` e não botão com Server Action: o arquivo é montado pela rota
          `/portal/dados/exportar`, que responde com os bytes e o cabeçalho que faz o
          navegador salvar. Uma ação não tem como entregar arquivo ao disco.
        */}
        <a href="/portal/dados/exportar" download className="btn btn-ghost mt-4 w-full">
          Baixar em PDF
        </a>
        {/*
          O JSON continua existindo, e de propósito — mas em segundo plano.

          Ele é o formato "estruturado e de leitura por máquina" do art. 19 da LGPD: o
          arquivo que outro petshop conseguiria importar, e o que serve se um dia a folha
          for contestada. Só que quem clica aqui quase nunca é uma máquina, e oferecer os
          dois com o mesmo peso faria a pessoa escolher no escuro entre um documento que
          ela lê e um que ela não lê. Fica de link, com o nome do formato à vista.
        */}
        <p className="hint mt-3 text-center">
          Prefere o arquivo para outro sistema?{' '}
          <a href="/portal/dados/exportar?formato=json" download className="underline">
            Baixar em JSON
          </a>
        </p>
      </Card>

      <Exclusao pedido={dados.deletionRequest} tenantName={tenantName} onPedido={setDados} />
    </>
  )
}

function porExtenso(data: string): string {
  // `T12:00` e não a data crua: `new Date('1990-04-12')` é meia-noite UTC, que no fuso de
  // Brasília cai no dia 11. Um aniversário exibido um dia antes é o tipo de erro que
  // ninguém reporta e todo mundo nota.
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(
    new Date(`${data}T12:00:00`),
  )
}

function cep(valor: string): string {
  return valor.length === 8 ? `${valor.slice(0, 5)}-${valor.slice(5)}` : valor
}
