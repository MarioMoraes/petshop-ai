import multipart from '@fastify/multipart'
import { SITE_PHOTO_MAX_BYTES } from '@petshop/shared-types'
import type { FastifyInstance } from 'fastify'
import { registerPublicSiteRoutes, registerSiteRoutes } from '../modules/site/routes.js'
import { registerTaxiRoutes } from '../modules/taxi/routes.js'
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
