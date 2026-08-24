/**
 * `@petshop/service-kit` — o mecanismo comum aos serviços do backend.
 *
 * O que mora aqui é o **como**: traduzir erro para problem+json, publicar no
 * RabbitMQ, degradar quando o Redis cai, mascarar PII na trilha de auditoria, conferir
 * a assinatura do gateway. O **quê** — quais códigos de erro existem, que chaves o
 * cache guarda, que eventos o serviço publica — continua em cada serviço, porque é ali
 * que se lê junto com as regras de negócio que o produzem.
 *
 * Por isso tudo aqui é fábrica e não singleton: cada serviço chama `createX` no seu
 * próprio módulo `lib/x.ts`, passa o seu catálogo, e continua importando de
 * `./lib/x.js` como antes. O pacote não conhece um único pet, tutor ou agendamento.
 */

export * from './env.js'
export * from './logger.js'
export * from './cache.js'
export * from './events.js'
export * from './errors.js'
export * from './validate.js'
export * from './audit.js'
export * from './security-events.js'
export * from './auth.js'
