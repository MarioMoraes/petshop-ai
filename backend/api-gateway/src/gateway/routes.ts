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
import {
  registerEmailWebhookRoutes,
  registerMessagingRoutes,
  registerWhatsappWebhookRoutes,
} from '../modules/messaging/routes.js'
import { registerPetRoutes } from '../modules/pets/routes.js'
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
 * (`/v1/messages`, `/v1/messaging`) ainda é o messaging-service, e o módulo continua
 * falando com ele por HTTP com contexto assinado — o mesmo salto de sempre, agora
 * partindo daqui.
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
 * `/v1/tutors/:id` continuam sendo de outros: `/packages` é do financeiro, ainda
 * encaminhado, e `/messages` é do MOD-NOTIF, que já vive aqui. Nenhuma das duas casa
 * com uma rota deste módulo, e é isso que as mantém funcionando — a do financeiro pelo
 * curinga do `proxy.ts`, a de mensagens pelo escopo do outro módulo.
 */
async function registerTutorModule(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    registerModuleAuth(scope)
    await registerTutorRoutes(scope)
    await registerTermRoutes(scope)
  })
}
