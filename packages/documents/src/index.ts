/**
 * `@petshop/documents` — o documento formal: registro, numeração, molde e arquivo.
 *
 * O SPEC §57 desenha um `document-service:3012`. Ele não nasce (PRD documentos_pdf_11
 * §MOD-DOC-01): um serviço central obrigaria cada serviço de domínio a mandar por HTTP o
 * payload clínico e financeiro que ele já tem em mãos, para receber de volta um arquivo.
 *
 * A fronteira é esta. **`@petshop/pdf`** fala com o Gotenberg e nada mais. **Este
 * pacote** guarda o que é comum a todo documento: a tabela `documents`, a série, o molde
 * de página e a ida ao bucket. **O serviço** guarda o miolo — só ele sabe o que é um
 * receituário.
 *
 * Como o `service-kit` e o `@petshop/pdf`, tudo aqui é **fábrica**: um pacote não pode
 * chamar o `loadEnv()` de um serviço.
 */

export * from './issue.js'
export * from './layout.js'
export * from './registry.js'
export * from './storage.js'
