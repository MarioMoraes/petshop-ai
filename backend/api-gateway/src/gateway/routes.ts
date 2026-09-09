import multipart from '@fastify/multipart'
import {
  MAX_PHOTOS_PER_UPLOAD,
  MAX_PHOTO_BYTES,
  SITE_PHOTO_MAX_BYTES,
} from '@petshop/shared-types'
import type { FastifyInstance } from 'fastify'
import { registerPublicSiteRoutes, registerSiteRoutes } from '../modules/site/routes.js'
import { registerCatalogRoutes } from '../modules/catalog/routes.js'
import { registerCrmRoutes } from '../modules/crm/routes.js'
import { registerIdentityRoutes } from '../modules/identity/routes.js'
import { registerLedgerRoutes } from '../modules/ledger/routes.js'
import { registerMedicalRecordRoutes } from '../modules/records/routes-module.js'
import {
  registerEmailWebhookRoutes,
  registerMessagingRoutes,
  registerWhatsappWebhookRoutes,
} from '../modules/messaging/routes.js'
import { registerPetRoutes } from '../modules/pets/routes.js'
import { registerSchedulingModule } from '../modules/scheduling/routes-module.js'
import { registerSecurityRoutes } from '../modules/security/routes.js'
import { registerPhotoRoutes } from '../modules/photos/routes.js'
import { registerTaxiRoutes } from '../modules/taxi/routes.js'
import { registerTermRoutes } from '../modules/terms/routes.js'
import { registerTutorRoutes } from '../modules/tutors/routes.js'
import { registerModuleAuth } from '../shared/auth-context.js'

/**
 * Composição das rotas dos módulos que já vivem neste processo.
 *
 * Cada fatia da consolidação acrescenta um bloco aqui e apaga um prefixo do
 * `proxy.ts`. O que **não** casar com nada registrado neste arquivo continua sendo
 * encaminhado ao serviço que ainda não migrou — é o que deixa a migração acontecer
 * uma fatia por vez sem quebrar o resto.
 *
 * A separação entre superfície pública e autenticada é por **escopo do Fastify**, e
 * não por convenção de nome de rota. Registrar uma rota administrativa fora do escopo
 * autenticado a deixa aberta ao mundo; o escopo é o que torna esse engano visível na
 * primeira leitura, em vez de invisível até alguém varrer a instalação.
 */

export async function registerModules(app: FastifyInstance): Promise<void> {
  await registerSiteModule(app)
  await registerTaxiModule(app)
  await registerCrmModule(app)
  await registerMessagingModule(app)
  await registerPetModule(app)
  await registerTutorModule(app)
  await registerIdentityModule(app)
  await registerSecurityModule(app)
  await registerMedicalRecordModule(app)
  await registerScheduleModule(app)
  await registerLedgerModule(app)
}

/**
 * MOD-SITE — o site do estabelecimento.
 *
 * Anônima: o visitante não tem sessão, e o tenant vem do host resolvido pelo Next.
 * Autenticada: o contexto que o hook do gateway resolveu vale só dentro do escopo.
 */
async function registerSiteModule(app: FastifyInstance): Promise<void> {
  await app.register(registerPublicSiteRoutes)

  await app.register(async (admin) => {
    /**
     * O parser de multipart é registrado **dentro do escopo**, de propósito.
     *
     * No nível do app, `multipart/form-data` é bufferizado byte a byte para seguir
     * intacto ao serviço que ainda não migrou (MOD-PET-04: o `boundary` está no
     * `content-type` e reserializar corromperia o arquivo). O upload da galeria é
     * consumido aqui mesmo, então precisa do parser de verdade — e um sobrepõe o
     * outro só neste ramo da árvore, que é o que a encapsulação do Fastify garante.
     *
     * **Sem `await`, e isso não é descuido.** Esperar por um `register` de dentro de
     * um plugin encapsulado trava o carregamento: a promessa do registro interno só
     * resolve quando a função do plugin retorna, e ela está esperando por ela mesma.
     * O sintoma é "Plugin did not start in time" depois de dez segundos, em toda rota
     * do escopo. O Fastify já encadeia o carregamento na ordem certa sozinho.
     *
     * O limite é a primeira barreira do upload: o arquivo grande demais é recusado no
     * parser, antes de ocupar memória do processo.
     */
    admin.register(multipart, {
      limits: { fileSize: SITE_PHOTO_MAX_BYTES, files: 1, fieldSize: 4096 },
    })

    registerModuleAuth(admin)
    await registerSiteRoutes(admin)
  })
}

/**
 * MOD-TAXI — o leva-e-traz.
 *
 * Sem superfície anônima: toda rota é da equipe ou do motorista, e o recorte de quem
 * enxerga o quê é da matriz de permissão, não do escopo. O escopo existe assim mesmo
 * para que o registro de uma rota fora dele seja visível — e porque o dia em que o
 * motorista tiver uma tela própria, é aqui que a fronteira vai ser desenhada.
 */
async function registerTaxiModule(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    registerModuleAuth(scope)
    await registerTaxiRoutes(scope)
  })
}

/**
 * MOD-CRM — o relacionamento.
 *
 * Só a metade que **decide** quem recebe o quê (`/v1/crm`). Quem **entrega**
 * (`/v1/messages`, `/v1/messaging`) é o MOD-NOTIF, logo abaixo — as duas metades
 * chegaram em fatias diferentes, e desde a 4 o salto HTTP entre elas é chamada de
 * função.
 */
async function registerCrmModule(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    registerModuleAuth(scope)
    await registerCrmRoutes(scope)
  })
}

/**
 * MOD-NOTIF e MOD-CRM-01 — a entrega.
 *
 * Três superfícies, e as duas primeiras **não** passam pelo escopo autenticado:
 *
 * - o callback da Evolution não conhece contrato nenhum nosso; quem o autentica é o
 *   token da instância, conferido dentro da própria rota;
 * - o webhook do Resend é autenticado pela assinatura Svix sobre o **corpo cru**, e
 *   por isso registra um parser próprio no escopo dele;
 * - o resto (`/v1/messages`, `/v1/messaging`) é da equipe, com o contexto resolvido.
 *
 * As duas primeiras moram sob `/internal/`, que o `app.ts` libera do hook de sessão
 * pelo prefixo. A do Resend é a única superfície de backend que a borda publica.
 */
async function registerMessagingModule(app: FastifyInstance): Promise<void> {
  await app.register(registerWhatsappWebhookRoutes)
  await app.register(registerEmailWebhookRoutes)

  await app.register(async (scope) => {
    registerModuleAuth(scope)
    await registerMessagingRoutes(scope)
  })
}

/**
 * MOD-PET — a ficha do animal, o catálogo e o álbum.
 *
 * Três grupos de rota num escopo só: eles compartilham o catálogo de erro e a matriz
 * de permissão, e separá-los daria três escopos com a mesma configuração.
 *
 * O `@fastify/multipart` daqui aceita **dez** arquivos de 10 MB (AC-02 do MOD-PET-04),
 * contra o único de 5 MB do site. São dois registros do mesmo plugin, em escopos
 * irmãos, com limites diferentes — que é a razão de o parser ser por escopo e não do
 * app.
 */
async function registerPetModule(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    scope.register(multipart, {
      limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS_PER_UPLOAD, fieldSize: 4096 },
    })

    registerModuleAuth(scope)
    await registerCatalogRoutes(scope)
    await registerPetRoutes(scope)
    await registerPhotoRoutes(scope)
  })
}

/**
 * MOD-TUTOR — a ficha do cliente e os termos.
 *
 * O módulo registra `/v1/tutors/…` e `/v1/terms/…`. Duas rotas **debaixo** de
 * `/v1/tutors/:id` são de outros módulos: `/packages` é do MOD-LEDGER e `/messages` é do
 * MOD-NOTIF. Nenhuma das duas casa com uma rota deste módulo, e desde a fatia 10 as
 * duas são atendidas pela árvore de rotas — um conflito real apareceria no boot, em vez
 * de uma delas sumir em silêncio como acontecia enquanto o desempate era uma checagem
 * de sufixo no `proxy.ts`.
 */
async function registerTutorModule(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    registerModuleAuth(scope)
    await registerTutorRoutes(scope)
    await registerTermRoutes(scope)
  })
}

/**
 * MOD-IDENT — a identidade, o tenant e a equipe.
 *
 * Registrado **depois dos módulos de domínio**, e a ordem não é estética: além de
 * `/v1/tenants/…` e `/v1/memberships/…`, que nenhum outro toca, o módulo declara
 * `/v1/roles` e `/v1/me`, que são a raiz de tudo o que o frontend pergunta primeiro.
 * Deixá-los depois garante que uma rota de domínio com o mesmo prefixo apareça no boot
 * como conflito do Fastify, e não como uma rota que some.
 *
 * Escopo autenticado, como os demais — mas aqui vale reler o que o hook faz e o que
 * não faz: `registerModuleAuth` exige **sessão**, nunca tenant. Três rotas do módulo
 * existem para quem ainda não tem tenant nenhum, e é `requireTenantContext`, dentro de
 * cada handler, que separa as duas coisas.
 */
async function registerIdentityModule(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    registerModuleAuth(scope)
    await registerIdentityRoutes(scope)
  })
}

/**
 * MOD-SEC — a leitura da trilha e dos eventos de segurança.
 *
 * Escopo autenticado próprio, com duas rotas de leitura e nenhuma de escrita. O gate de
 * MFA do módulo **não** mora aqui: ele roda em `auth/session.ts`, antes do roteamento,
 * porque precisa valer também para as rotas que ainda são encaminhadas a outro processo.
 */
async function registerSecurityModule(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    registerModuleAuth(scope)
    await registerSecurityRoutes(scope)
  })
}

/**
 * MOD-LEDGER — a conta corrente do tutor.
 *
 * A última fatia de domínio da consolidação, e a que apagou a **última exceção de
 * prefixo do `proxy.ts`**: `/v1/tutors/:tutorId/packages` mora debaixo do espaço do
 * MOD-TUTOR e era desempatada por uma checagem de sufixo conferida antes do prefixo do
 * tutor. Com os dois na mesma árvore, quem desempata é o roteador — e `:tutorId` aqui
 * convive com `:id` lá, como o `:petId` do prontuário já convivia.
 *
 * Registrado depois do MOD-TUTOR, pela mesma razão que o MOD-PRONT vem depois do
 * MOD-PET: quem pendura rota no espaço de outro vem depois de quem define o espaço.
 */
async function registerLedgerModule(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    registerModuleAuth(scope)
    await registerLedgerRoutes(scope)
  })
}

/**
 * MOD-AGENDA — o catálogo da agenda e os agendamentos.
 *
 * Escopo autenticado, sem superfície anônima: o Portal marca horário pelo `portal-bff`,
 * que chega com o contexto já resolvido pela porta interna, e não por aqui.
 *
 * **Registrado depois do MOD-PET, como o MOD-PRONT.** Os prefixos são distintos —
 * `/v1/services` e `/v1/sizes` não colidem —, mas a ordem mantém a mesma leitura: os
 * módulos que penduram rota no espaço de outro vêm depois de quem define o espaço.
 */
async function registerScheduleModule(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    registerModuleAuth(scope)
    await registerSchedulingModule(scope)
  })
}

/**
 * MOD-PRONT — o prontuário, o atendimento e o receituário.
 *
 * Registrado **depois do MOD-PET**, e a ordem é o que torna a fatia legível: as rotas
 * deste módulo penduram-se sob `/v1/pets/:petId/…`, o mesmo espaço que o módulo do
 * animal ocupa. Enquanto era serviço, quem as separava era uma lista de sufixos no
 * `proxy.ts`, conferida antes do prefixo do pet e frágil por construção. Agora as duas
 * famílias estão na mesma árvore, e um conflito real aparece no boot em vez de fazer uma
 * rota sumir em silêncio.
 */
async function registerMedicalRecordModule(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    registerModuleAuth(scope)
    await registerMedicalRecordRoutes(scope)
  })
}
