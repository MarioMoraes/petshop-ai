import { createCache } from '@petshop/service-kit'
import { loadEnv } from '../config/env.js'
import { logger } from './logger.js'

/**
 * Cache do PRD §10. Compartilhado entre réplicas — é o que permite que a verificação
 * de permissão fique no p95 de 15ms com cache quente.
 *
 * Toda operação degrada em silêncio: Redis fora do ar deixa o processo mais lento,
 * nunca indisponível.
 *
 * **As chaves são namespaced por módulo e o namespace é contrato.** Elas atravessam
 * processos hoje (os serviços que ainda não migraram invalidam chave daqui) e vão
 * continuar atravessando réplicas depois. Renomear uma é uma migração, não um refino.
 */

export const CACHE_KEYS = {
  jwks: 'clerk:jwks',
  permissions: (tenantId: string, userId: string) => `perm:${tenantId}:${userId}`,
  tenantByOrg: (clerkOrgId: string) => `tenant:org:${clerkOrgId}`,
  tenantStatus: (tenantId: string) => `tenant:status:${tenantId}`,
  tenantPlan: (tenantId: string) => `tenant:plan:${tenantId}`,
  /**
   * O preço vigente dos planos — **uma chave só na instalação**, sem tenant.
   *
   * O preço não é de estabelecimento nenhum: é a tabela que o console da plataforma
   * mantém. A escrita a apaga (`invalidatePlanPrices`), então o TTL é rede de segurança
   * contra uma réplica que perdeu o `DEL`, e não o mecanismo de atualização.
   */
  planPrices: 'plan:prices',
  userByClerkId: (clerkUserId: string) => `user:clerk:${clerkUserId}`,

  // ---- MOD-IDENT ----
  tenantSettings: (tenantId: string) => `tenant:settings:${tenantId}`,
  /**
   * **Declarada e não usada, de propósito.** Veio assim do identity-service: nenhum
   * caminho escreve ou lê `tenant:slug:`. Ela fica porque o namespace continua
   * reservado — é o que o `portalTenantBySlug` logo abaixo evita colidir — e apagá-la
   * faria a próxima pessoa a precisar de um cache por slug escolher justamente este
   * nome, sem o aviso.
   */
  tenantSlug: (slug: string) => `tenant:slug:${slug}`,

  /**
   * Namespace `portal:` de propósito. O MOD-IDENT já declara um `tenant:slug:{slug}`
   * logo acima, e duas chaves com o mesmo nome e formatos diferentes é o tipo de
   * colisão que só aparece quando as duas estão quentes ao mesmo tempo.
   */
  portalTenantBySlug: (slug: string) => `portal:tenant:${slug}`,
  /**
   * A sessão do Portal.
   *
   * O nome era **contrato entre serviços**: o tutor-service declarava o mesmo literal
   * no cache dele para poder apagar esta chave ao desvincular o acesso, com um
   * comentário pedindo que os dois ficassem em dia. Com o MOD-TUTOR aqui dentro, a
   * duplicata sumiu — sobrou uma declaração só, e o AC-05 de MOD-PORTAL-02 continua
   * valendo antes do TTL. Com o MOD-IDENT dentro na fatia 7, o `perm:` também deixou
   * de ser declarado em dois lugares: **nenhuma chave deste arquivo é mais contrato
   * entre processos.** O que sobra são as réplicas, que compartilham o mesmo Redis —
   * renomear continua sendo migração, não refino.
   */
  portalSession: (tenantId: string, userId: string) => `portal:session:${tenantId}:${userId}`,

  /**
   * O que o Portal guarda, e é pouco de propósito (RN-16): **nada com dado pessoal entra
   * aqui**. Configuração do tenant e contador de rate limit; o extrato, a ficha e a agenda
   * do tutor são lidos sob demanda, a cada requisição.
   *
   * `portalFeatures` e `portalCooldown` ganharam o prefixo do módulo na fatia 11 — no
   * serviço eram `tenantFeatures` e `cooldown`, genéricos demais para um arquivo que já tem
   * `tenantSettings`, `taxiSettings` e `messagingSettings`. **Os literais que vão para o
   * Redis não mudaram.**
   *
   * Os dois baldes do desafio são por **hash** do identificador, nunca pelo e-mail ou pelo
   * telefone: a chave de cache é o lugar mais fácil de vazar o par "esta pessoa é cliente
   * deste petshop".
   */
  portalFeatures: (tenantId: string) => `portal:features:${tenantId}`,

  // ---- MOD-AI ----
  /** A configuração do agente, lida uma vez por mensagem recebida. */
  agentSettings: (tenantId: string) => `agent:settings:${tenantId}`,
  /**
   * O gasto do mês com o provedor do modelo (§10 do PRD).
   *
   * TTL curto e **sem invalidação**: o número anda a cada turno, e derrubá-lo a cada
   * resposta custaria mais que o minuto de imprecisão. O teto que ele protege é mensal —
   * um minuto de atraso nele não muda decisão nenhuma.
   */
  agentSpend: (tenantId: string, yearMonth: string) => `agent:spend:${tenantId}:${yearMonth}`,
  challengeByIdentifier: (tenantId: string, identifierHash: string) =>
    `portal:rl:id:${tenantId}:${identifierHash}`,
  challengeByIp: (tenantId: string, ip: string) => `portal:rl:ip:${tenantId}:${ip}`,
  /** Cooldown do AC-05 de MOD-PORTAL-01, depois de esgotadas as tentativas. */
  portalCooldown: (tenantId: string, identifierHash: string) =>
    `portal:cooldown:${tenantId}:${identifierHash}`,

  // ---- MOD-SITE ----
  publicSite: (tenantId: string) => `site:public:${tenantId}`,
  host: (slug: string) => `site:host:${slug}`,
  /**
   * **O cache negativo não é detalhe.** Sem ele, um bot varrendo subdomínios
   * inexistentes vira uma consulta ao banco por requisição — e o único jeito de
   * descobrir que `xyz.dominio` não existe é perguntar. Com ele, vira uma consulta a
   * cada cinco minutos por host.
   */
  hostMiss: (slug: string) => `site:host:miss:${slug}`,
  leadRate: (tenantId: string, ip: string) => `site:rl:${tenantId}:${ip}`,

  // ---- MOD-TAXI ----
  zones: (tenantId: string) => `taxi:zones:${tenantId}`,
  vehicles: (tenantId: string) => `taxi:vehicles:${tenantId}`,
  taxiSettings: (tenantId: string) => `taxi:settings:${tenantId}`,
  board: (tenantId: string, date: string) => `taxi:board:${tenantId}:${date}`,
  route: (tenantId: string, driverId: string, date: string) =>
    `taxi:route:${tenantId}:${driverId}:${date}`,

  // ---- MOD-NOTIF / MOD-CRM-01 ----
  messagingSettings: (tenantId: string) => `msgcfg:${tenantId}`,
  template: (tenantId: string, key: string, channel: string) => `tpl:${tenantId}:${key}:${channel}`,
  consent: (tenantId: string, tutorId: string) => `consent:${tenantId}:${tutorId}`,
  /** Janela de um minuto; a chave morre sozinha. */
  rate: (tenantId: string, minute: string) => `msgrate:${tenantId}:${minute}`,
  /** Teto diário, no dia civil do fuso do tenant. */
  dailyCap: (tenantId: string, date: string) => `msgcap:${tenantId}:${date}`,

  // ---- MOD-PET ----
  pet: (tenantId: string, petId: string) => `pet:${tenantId}:${petId}`,

  // ---- MOD-PRONT ----
  /**
   * Alertas agregados do pet — alergia, temperamento e alerta médico.
   *
   * O item mais quente do prontuário: é lido em toda abertura de ficha, em todo
   * agendamento e em todo check-in. O TTL é o mais curto do módulo de propósito —
   * alerta de segurança desatualizado é pior que ausência de cache.
   */
  alerts: (tenantId: string, petId: string) => `pront:alerts:${tenantId}:${petId}`,
  petsByTutor: (tenantId: string, tutorId: string) => `pet:bytutor:${tenantId}:${tutorId}`,
  catalog: (tenantId: string, type: string) => `catalog:${tenantId}:${type}`,
  photoUrls: (photoId: string) => `photo:url:${photoId}`,

  // ---- MOD-TUTOR ----
  tutor: (tenantId: string, tutorId: string) => `tutor:${tenantId}:${tutorId}`,
  consents: (tenantId: string, tutorId: string) => `tutor:consent:${tenantId}:${tutorId}`,
  /** Resolução telefone → tutorId, usada pelo agente de IA no WhatsApp. */
  phone: (tenantId: string, phoneHash: string) => `tutor:phone:${tenantId}:${phoneHash}`,
  tagCounts: (tenantId: string) => `tutor:tagcount:${tenantId}`,
  cep: (zipCode: string) => `cep:${zipCode}`,
  /**
   * Estado da conexão de WhatsApp. Existe porque a cascata de canal o consulta uma vez
   * por candidato, por mensagem — e o estado só muda quando um webhook chega, que é
   * quando esta chave é derrubada.
   */
  whatsapp: (tenantId: string) => `wa:${tenantId}`,
  /**
   * O QR **corrente** do pareamento.
   *
   * A Evolution roda o código a cada ~45s e empurra cada troca pelo webhook. Sem este
   * cache o evento chegava e era descartado, a tela ficava com o primeiro código para
   * sempre, e todo pareamento falhava com "tente novamente mais tarde".
   */
  whatsappQr: (tenantId: string) => `waqr:${tenantId}`,

  // ---- MOD-ADMIN ----
  /**
   * O vínculo de plataforma de um login.
   *
   * Consultada uma vez por sessão **sem Organization**, e o caso comum é o negativo —
   * toda equipe de todo petshop que troque de contexto no Clerk passa por aqui e não é da
   * plataforma. Por isso o `null` também vai a cache: sem isso, a resposta mais frequente
   * seria a única a consultar o banco sempre.
   *
   * O grant de suporte, ao contrário, **não entra em cache nenhum** (RN-03 do PRD 14): ele
   * existe para o caso em que o estabelecimento quer que o acesso pare agora, e cinco
   * minutos de chave quente dariam ao suporte cinco minutos depois do clique.
   */
  platformAdmin: (clerkUserId: string) => `platform:admin:${clerkUserId}`,
  /**
   * O painel de saúde inteiro, montado (MOD-ADMIN-04).
   *
   * Chave fixa, sem tenant: o que ela guarda é o estado do processo e das dependências
   * dele, que é igual para quem quer que pergunte. **A única invalidação é o TTL** — as
   * sondas custam o que custam, e quinze segundos é curto o bastante para ninguém decidir
   * nada com informação velha.
   */
  platformHealth: 'platform:health',

  // ---- MOD-LEDGER ----
  /**
   * O saldo e os pacotes do tutor, e as políticas de cobrança do tenant.
   *
   * **O saldo nunca é servido do cache em operação de escrita**: lançamento, pagamento e
   * consumo de crédito leem a conta com `SELECT … FOR UPDATE` direto no Postgres. Estas
   * chaves existem para leitura de tela, onde alguns segundos de defasagem custam menos
   * que a latência somada em cada abertura da ficha do tutor.
   *
   * `ledgerSettings` ganhou o prefixo do módulo na fatia 10 — o literal que vai para o
   * Redis continua `ledger:settings:{tenantId}`, que é o que importa em infraestrutura.
   * O nome no objeto mudou porque o processo já tem `tenantSettings`, `taxiSettings` e
   * `messagingSettings`: um `settings` solto entre eles seria o único que não diz de
   * quem é.
   */
  balance: (tenantId: string, tutorId: string) => `ledger:balance:${tenantId}:${tutorId}`,
  packages: (tenantId: string, tutorId: string) => `ledger:packages:${tenantId}:${tutorId}`,
  ledgerSettings: (tenantId: string) => `ledger:settings:${tenantId}`,

  // ---- MOD-AGENDA ----
  /**
   * O catálogo da agenda — serviços, profissionais e a jornada de cada um.
   *
   * **As três são declaradas e nenhuma é lida hoje**, e vieram assim do
   * scheduling-service: só `invalidateScheduleCatalog` as toca, apagando chaves que
   * ninguém escreve. Ficam pela mesma razão que o `tenantSlug` acima — o namespace
   * `agenda:` continua reservado, e apagá-las faria a próxima pessoa a colocar o
   * catálogo em cache escolher justamente estes nomes sem o aviso. O §10 do PRD
   * agenda_operacao_06 as prevê: o catálogo muda quase nunca e é lido em toda abertura
   * do formulário de agendamento.
   *
   * A agenda do dia deliberadamente **não** tem chave: ela muda a cada check-in, e
   * agenda velha na tela da recepção é pior que agenda lenta.
   */
  services: (tenantId: string) => `agenda:services:${tenantId}`,
  professionals: (tenantId: string) => `agenda:professionals:${tenantId}`,
  schedule: (tenantId: string, professionalId: string) =>
    `agenda:schedule:${tenantId}:${professionalId}`,
} as const

export const CACHE_TTL_SECONDS = {
  jwks: 3600,
  permissions: 300,
  tenantByOrg: 3600,
  tenantStatus: 60,
  // Curto como o do status, e pela mesma razão: quem sobe de plano não espera uma hora
  // para ver o recurso, e quem desce não o usa por uma hora a mais.
  tenantPlan: 60,
  // Minutos, e não uma hora: mudar preço é raro, mas quando acontece quem fez a mudança
  // abre a landing em seguida para conferir. A escrita já derruba a chave.
  planPrices: 300,
  userByClerkId: 300,

  tenantSettings: 600,
  tenantSlug: 3600,

  portalTenantBySlug: 3600,
  /**
   * Curto de propósito. É o mecanismo que substitui o `permVersion` na sessão do
   * Portal: o claim vem do metadata do membership no Clerk, e o tutor não tem
   * membership. Desvincular o acesso apaga esta chave; o minuto é o pior caso de quem
   * revoga com a chave já apagada por outra réplica (AC-05 de MOD-PORTAL-02).
   */
  portalSession: 60,

  publicSite: 600,
  host: 3600,
  hostMiss: 300,

  zones: 3600,
  vehicles: 3600,
  taxiSettings: 3600,
  board: 20,
  /**
   * O TTL mais curto do sistema, de propósito: a rota do motorista é recarregada em
   * rede móvel a cada parada, e rota velha manda o motorista para o endereço errado.
   */
  route: 15,

  messagingSettings: 600,
  template: 600,
  /**
   * Cinco minutos, e não uma hora: o consentimento é o que separa "mandar" de "não
   * mandar", e um opt-out registrado no balcão precisa valer antes que o tutor
   * reclame de novo. Invalidado também por `tutor.updated` (RN-02).
   */
  consent: 300,
  rate: 120,

  pet: 120,
  /** RN-02 do MOD-PRONT exige alerta fresco na agenda e no check-in. */
  alerts: 120,
  petsByTutor: 300,
  catalog: 86_400,
  /** Abaixo dos 900s da assinatura: cache nunca deve servir URL prestes a vencer. */
  photoUrls: 840,

  tutor: 120,
  consents: 300,
  phone: 600,
  tagCounts: 300,
  cep: 86_400,
  /**
   * Um minuto. Curto porque o preço de errar é assimétrico: com o cache velho dizendo
   * "conectado" a mensagem falha e volta para a fila; dizendo "desconectado" ela cai
   * para o e-mail sem precisar. O webhook invalida na hora — este TTL cobre o caso em
   * que ele se perde.
   */
  whatsapp: 60,
  /**
   * Um pouco mais que o giro do provedor (~45s), para que a chave nunca fique vazia
   * entre uma troca e a seguinte. Curto assim de propósito: QR é o que mais depressa
   * apodrece, e um código vencido na tela é pior que nenhum.
   */
  whatsappQr: 90,

  platformAdmin: 300,
  platformHealth: 15,

  balance: 60,
  packages: 300,
  ledgerSettings: 900,

  services: 3_600,
  professionals: 3_600,
  schedule: 3_600,

  portalFeatures: 300,

  agentSettings: 300,
  agentSpend: 60,
} as const

export const { getRedis, cacheGet, cacheSet, cacheDelete, closeRedis } = createCache({
  logger,
  getUrl: () => loadEnv().REDIS_URL,
  isDisabled: () => loadEnv().DISABLE_REDIS,
})

/**
 * Descarta o payload montado de um tenant.
 *
 * Chamado por toda escrita do módulo do site e pelos consumidores de
 * `tenant.configuracao.atualizada` e `agenda.servico.alterado` — o horário corrigido
 * às 9h não pode aparecer ao meio-dia (AC-02 de MOD-SITE-06).
 */
export async function invalidateSite(tenantId: string, slug?: string): Promise<void> {
  await cacheDelete(
    CACHE_KEYS.publicSite(tenantId),
    ...(slug ? [CACHE_KEYS.host(slug), CACHE_KEYS.hostMiss(slug)] : []),
  )
}

/**
 * A configuração e as zonas decidem preço (MOD-TAXI).
 *
 * Uma zona alterada com o cache quente cobraria o valor antigo na próxima corrida — e
 * o preço congela na criação (RN-07), então o erro seria permanente naquela corrida,
 * não transitório.
 */
export async function invalidatePricing(tenantId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.zones(tenantId), CACHE_KEYS.taxiSettings(tenantId))
}

/**
 * Consome uma vaga na janela do minuto corrente (MOD-NOTIF).
 *
 * Devolve `false` quando o teto já foi atingido — e `true` quando não há Redis, porque
 * bloquear o envio inteiro por falta de cache seria trocar uma degradação por uma
 * parada.
 */
export async function consumeRateSlot(tenantId: string, perMinuteCap: number): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return true

  const minute = new Date().toISOString().slice(0, 16)
  const key = CACHE_KEYS.rate(tenantId, minute)
  try {
    const used = await redis.incr(key)
    if (used === 1) await redis.expire(key, CACHE_TTL_SECONDS.rate)
    return used <= perMinuteCap
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'falha ao contar vazão — seguindo sem teto')
    return true
  }
}

/**
 * Teto diário, cobrado **só de MARKETING** (RN-05): lembrete e aviso de taxi não podem
 * ser represados por um teto pensado para campanha.
 */
export async function consumeDailySlot(
  tenantId: string,
  date: string,
  dailyCap: number,
): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return true

  const key = CACHE_KEYS.dailyCap(tenantId, date)
  try {
    const used = await redis.incr(key)
    // 36h de vida: cobre o dia civil inteiro em qualquer fuso sem precisar calcular a
    // virada, e a chave do dia seguinte é outra.
    if (used === 1) await redis.expire(key, 129_600)
    return used <= dailyCap
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'falha ao contar teto diário — seguindo sem teto')
    return true
  }
}

export async function invalidateSettings(tenantId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.messagingSettings(tenantId))
}

/**
 * Invalida tudo o que depende de um pet (MOD-PET).
 *
 * Os tutores entram na lista porque o Portal lista "meus pets" por tutor: mudar o pet
 * sem invalidar essa chave deixaria o tutor vendo o nome antigo por cinco minutos.
 */
export async function invalidatePet(
  tenantId: string,
  petId: string,
  tutorIds: string[] = [],
): Promise<void> {
  await cacheDelete(
    CACHE_KEYS.pet(tenantId, petId),
    ...tutorIds.map((tutorId) => CACHE_KEYS.petsByTutor(tenantId, tutorId)),
  )
}

/**
 * Invalida o alerta do pet **e** o cache do próprio pet, que embute `alerts[]`.
 *
 * As duas chaves eram de serviços diferentes, e apagá-las juntas era deliberado: o
 * evento `prontuario.alerta.alterado` também invalida a do pet, mas o consumidor é
 * assíncrono, e dois segundos de alerta errado bastam para alguém usar o shampoo
 * errado. Com os dois módulos no mesmo processo a corrida some, e a chamada dupla
 * continua sendo a mais barata — não há motivo para depender do evento aqui.
 */
export async function invalidateAlerts(tenantId: string, petId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.alerts(tenantId, petId), CACHE_KEYS.pet(tenantId, petId))
}

/**
 * Invalidação **ativa** do saldo, não só por TTL (MOD-LEDGER).
 *
 * Sessenta segundos de defasagem são aceitáveis para quem abre a ficha; não são para
 * quem acabou de registrar o pagamento e olha para a tela esperando o saldo zerar.
 */
export async function invalidateAccount(tenantId: string, tutorId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.balance(tenantId, tutorId))
}

/** Muda um pacote → some o saldo junto: compra e resgate mexem nos dois. */
export async function invalidatePackages(tenantId: string, tutorId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.packages(tenantId, tutorId), CACHE_KEYS.balance(tenantId, tutorId))
}

/**
 * As políticas de cobrança do tenant (MOD-LEDGER).
 *
 * O nome não é `invalidateSettings`: esse já é do MOD-NOTIF, logo acima, e apaga a
 * configuração de mensageria. Duas funções com o mesmo nome em `shared/` significaria
 * que uma delas apaga a chave errada — e uma configuração de cobrança que não invalida
 * é um método de pagamento desligado que continua aceitando por quinze minutos.
 */
export async function invalidateLedgerSettings(tenantId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.ledgerSettings(tenantId))
}

/**
 * Invalida o catálogo da agenda inteiro do tenant (MOD-AGENDA).
 *
 * Grosso de propósito: mudar um serviço mexe em quem pode executá-lo, e mudar um
 * profissional mexe em que serviços aparecem no seletor. Invalidar as três chaves
 * custa três `DEL` e evita a classe inteira de bug em que a habilitação some da lista
 * mas continua valendo no cálculo.
 *
 * **O nome ganhou o prefixo `Schedule` na fatia 9**, e não é cosmético: o processo já
 * tem um `CACHE_KEYS.catalog`, que é o catálogo de domínio do MOD-PET — espécie, raça,
 * porte e pelagem. Um `invalidateCatalog` ao lado dele leria como se apagasse aquele, e
 * é exatamente o tipo de colisão que não dá erro nenhum.
 */
export async function invalidateScheduleCatalog(
  tenantId: string,
  professionalIds: string[] = [],
): Promise<void> {
  await cacheDelete(
    CACHE_KEYS.services(tenantId),
    CACHE_KEYS.professionals(tenantId),
    ...professionalIds.map((id) => CACHE_KEYS.schedule(tenantId, id)),
  )
}

/** Invalida tudo o que depende de um tutor. Chamado depois de qualquer escrita. */
export async function invalidateTutor(
  tenantId: string,
  tutorId: string,
  phoneHashes: string[] = [],
): Promise<void> {
  await cacheDelete(
    CACHE_KEYS.tutor(tenantId, tutorId),
    CACHE_KEYS.consents(tenantId, tutorId),
    CACHE_KEYS.tagCounts(tenantId),
    ...phoneHashes.map((hash) => CACHE_KEYS.phone(tenantId, hash)),
  )
}
