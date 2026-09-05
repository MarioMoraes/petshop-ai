import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do portal-bff, validada na subida.
 *
 * A porta 3020 vem do PRD portal_tutor_09 §"Serviço Backend" — fora do bloco 3009-3013
 * de propósito, porque o Portal é superfície de outro público e não mais um serviço de
 * domínio. O gateway resolve por `PORTAL_BFF_URL`; nenhum código depende do número.
 *
 * `ENCRYPTION_KEK` vem do `serviceEnvShape` e **não é usada aqui**: o BFF não decifra
 * nada (RN-16), e os dados pessoais que ele exibe chegam já decifrados dos serviços de
 * domínio. Fica pelo shape comum, não por necessidade.
 */

export const { loadEnv, resetEnvCache } = defineEnv('portal-bff', {
  ...serviceEnvShape,
  PORTAL_BFF_PORT: z.coerce.number().int().default(3020),
  APP_DOMAIN: z.string().default('localhost:3002'),
  MESSAGING_SERVICE_URL: z.string().url().default('http://localhost:3010'),
  /**
   * O serviço da agenda, para onde vai todo agendamento marcado pelo Portal.
   *
   * O BFF fala com ele **direto**, e não pelo gateway: o gateway existe para validar
   * JWT do Clerk e resolver tenant, e o BFF já tem as duas coisas resolvidas. Passar
   * por ele só somaria um salto e um ponto de falha.
   */
  SCHEDULING_SERVICE_URL: z.string().url().default('http://localhost:3006'),

  /**
   * O serviço financeiro, para **emitir** o recibo do pagamento (MOD-PORTAL-08).
   *
   * O extrato e o saldo não passam por aqui — são leitura, e o BFF lê o banco direto.
   * Esta URL existe só para o `GET /v1/payments/:id/receipt`, que gera o PDF quando
   * ele ainda não existe. Ver `modules/portal/ledger-port.ts`.
   */
  BILLING_LEDGER_SERVICE_URL: z.string().url().default('http://localhost:3007'),

  /**
   * O Taxi Dog, para cotar e pedir o leva-e-traz junto do agendamento (MOD-PORTAL-07).
   *
   * Mesmo desenho da agenda: quem valida capacidade, zona e janela é o serviço de
   * domínio. O BFF pergunta o preço, pergunta se há motorista e pede a corrida — as três
   * são operações que o taxidog-service já expunha ao balcão.
   */
  TAXIDOG_SERVICE_URL: z.string().url().default('http://localhost:3008'),

  /**
   * O serviço de tutores, para **gravar** a preferência de comunicação (MOD-PORTAL-10).
   *
   * A leitura do consentimento é banco direto, como o resto do módulo. Esta URL existe
   * só para o `PUT /v1/tutors/:id/consents`, que além da linha append-only derruba os
   * caches da ficha e publica os eventos de consentimento. Ver `modules/portal/
   * tutor-port.ts`.
   */
  TUTOR_SERVICE_URL: z.string().url().default('http://localhost:3003'),

  /**
   * O bucket das fotos, só para **assinar** o endereço de leitura (`lib/photo-urls.ts`).
   *
   * Opcionais pela mesma razão do pet-service, e a consequência aqui é ainda mais
   * branda: sem eles a ficha do pet vem sem retrato, e nada além disso deixa de
   * funcionar. Exigi-los na subida trancaria o Portal inteiro por causa de uma imagem.
   */
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('petshop-media'),
  /** R2 ignora região, mas o assinador SigV4 do SDK exige uma. */
  R2_REGION: z.string().default('auto'),
})

export type Env = ReturnType<typeof loadEnv>
