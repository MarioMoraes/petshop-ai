/**
 * `@petshop/job-scheduler` — o relógio dos jobs.
 *
 * O PRD chama isto de MOD-CRON e o desenha como serviço próprio. Aqui ele é um pacote,
 * e a razão é onde os jobs já moram: as cinco varreduras que precisam de relógio vivem
 * dentro do serviço dono do domínio, porque descobrir o que fazer é uma consulta ao
 * banco desse domínio. Um serviço de cron chamando HTTP acrescentaria endpoints
 * internos, um caminho de autenticação sem tenant e uma imagem a mais para operar — em
 * troca de nada que o agendador in-process não faça.
 *
 * A fronteira é a mesma do `service-kit`: **mecanismo aqui, catálogo no serviço**. Este
 * pacote sabe ler uma expressão cron, garantir que só uma réplica execute e registrar o
 * que aconteceu. Ele não sabe o que é um no-show, um pacote vencido ou uma conta
 * divergente — e não deve saber.
 */

export * from './cron.js'
export * from './lease.js'
export * from './runner.js'
