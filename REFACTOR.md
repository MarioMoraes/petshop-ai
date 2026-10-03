Quero que você faça uma REFATORAÇÃO COMPLETA E CONTROLADA deste projeto SaaS.

IMPORTANTE: NÃO comece alterando código imediatamente.

Seu primeiro objetivo é entender profundamente a arquitetura atual, identificar problemas e elaborar um plano de refatoração seguro.

## 1. AUDITORIA INICIAL

Analise todo o projeto antes de modificar qualquer arquivo.

Inspecione, entre outros:

* Estrutura de diretórios
* Backend
* Frontend
* Banco de dados
* ORM
* Migrations
* Autenticação e autorização
* Multi-tenancy
* APIs
* Services
* Controllers
* Repositories
* DTOs
* Middlewares
* Validações
* Tratamento de erros
* Logs
* Cache
* Filas
* Jobs/workers
* Integrações externas
* Variáveis de ambiente
* Docker
* Docker Compose
* Infraestrutura
* CI/CD
* Testes
* Tipagem
* Configurações
* Dependências
* Código duplicado
* Código morto
* Débitos técnicos
* Problemas de segurança
* Problemas de performance
* Problemas de escalabilidade

Leia também os arquivos de documentação existentes, especialmente:

* README
* CLAUDE.md
* documentação de arquitetura
* arquivos de configuração
* ADRs
* arquivos de infraestrutura

Não assuma que a arquitetura atual está correta.

## 2. MAPEAMENTO DA ARQUITETURA

Antes de alterar código, produza uma visão da arquitetura atual.

Identifique:

* componentes
* responsabilidades
* dependências
* fluxo de dados
* comunicação entre serviços
* comunicação frontend/backend
* acesso ao banco
* utilização de Redis
* utilização de RabbitMQ
* autenticação
* autorização
* isolamento de tenants

Identifique também violações de princípios arquiteturais.

Exemplos:

* responsabilidades misturadas
* alto acoplamento
* baixa coesão
* services gigantes
* controllers com regra de negócio
* acesso direto ao banco em locais inadequados
* lógica duplicada
* dependências circulares
* abstrações desnecessárias
* código difícil de testar
* código difícil de manter

## 3. MULTI-TENANCY

Dê atenção especial ao isolamento entre tenants.

Verifique se:

* toda entidade que deveria possuir tenant_id possui tenant_id
* queries filtram corretamente pelo tenant
* repositories respeitam o tenant atual
* services não conseguem acessar dados de outro tenant acidentalmente
* relacionamentos respeitam o tenant
* jobs assíncronos carregam o contexto do tenant
* cache possui isolamento por tenant
* filas possuem contexto suficiente para identificar o tenant
* endpoints não permitem manipulação de IDs pertencentes a outro tenant
* existe risco de IDOR ou vazamento de dados entre tenants

Se houver PostgreSQL Row-Level Security, analise também sua implementação.

## 4. SEGURANÇA

Faça uma auditoria de segurança.

Procure principalmente:

* SQL injection
* autorização inadequada
* IDOR
* exposição de dados
* secrets no código
* secrets no Git
* validação insuficiente
* ausência de rate limiting
* CORS inadequado
* JWT/session mal configurado
* permissões excessivas
* endpoints administrativos expostos
* logs contendo informações sensíveis
* uploads inseguros
* SSRF
* XSS
* CSRF quando aplicável
* problemas relacionados a multi-tenancy

Classifique cada problema por:

CRÍTICO
ALTO
MÉDIO
BAIXO

## 5. PERFORMANCE

Identifique gargalos potenciais.

Analise:

* queries N+1
* queries sem índices
* joins desnecessários
* consultas repetidas
* utilização incorreta de Redis
* utilização incorreta de RabbitMQ
* processamento síncrono que deveria ser assíncrono
* operações pesadas dentro de requests
* paginação
* processamento de grandes volumes
* chamadas externas
* cache
* frontend com renders desnecessários
* bundle size
* chamadas duplicadas à API

Não faça otimizações prematuras.

Primeiro identifique os gargalos reais ou potenciais e explique o motivo.

## 6. QUALIDADE DO CÓDIGO

Procure:

* código duplicado
* funções muito grandes
* classes muito grandes
* arquivos muito grandes
* nomes ruins
* abstrações desnecessárias
* comentários que compensam código confuso
* constantes mágicas
* strings duplicadas
* tipos incorretos
* any desnecessário
* tratamento de erro inconsistente
* padrões diferentes para resolver o mesmo problema
* funções com responsabilidades múltiplas

## 7. TESTES

Avalie a estratégia de testes atual.

Identifique:

* ausência de testes
* testes frágeis
* testes duplicados
* testes que não validam comportamento importante
* ausência de testes de integração
* ausência de testes de autorização
* ausência de testes de isolamento entre tenants
* ausência de testes para regras críticas

Não crie testes apenas para aumentar cobertura.

Priorize testes que protejam regras de negócio e comportamentos críticos.

## 8. DEPENDÊNCIAS

Analise as dependências do projeto.

Identifique:

* dependências não utilizadas
* dependências duplicadas
* dependências obsoletas
* dependências com problemas conhecidos
* versões incompatíveis
* dependências que podem ser substituídas por funcionalidades já existentes no projeto

NÃO atualize dependências major automaticamente.

Para upgrades potencialmente quebradores, apresente primeiro os riscos.

## 9. PLANO DE REFATORAÇÃO

Depois da auditoria, NÃO altere código ainda.

Crie um plano dividido em fases.

Exemplo:

FASE 1 — Segurança e correções críticas
FASE 2 — Arquitetura
FASE 3 — Backend
FASE 4 — Frontend
FASE 5 — Banco de dados
FASE 6 — Cache e filas
FASE 7 — Testes
FASE 8 — Performance
FASE 9 — Infraestrutura
FASE 10 — Limpeza final

Para cada fase informe:

* objetivo
* arquivos envolvidos
* problemas resolvidos
* riscos
* dependências
* impacto esperado
* como validar
* estratégia de rollback

## 10. PRINCÍPIO FUNDAMENTAL

A refatoração NÃO deve alterar o comportamento funcional do sistema sem que isso seja explicitamente planejado.

Preserve:

* APIs existentes
* regras de negócio
* contratos
* banco de dados
* integrações
* autenticação
* autorização
* comportamento do frontend

Quando uma alteração funcional for necessária, identifique-a explicitamente.

## 11. FORMA DE EXECUÇÃO

Depois que o plano estiver pronto, execute a refatoração FASE POR FASE.

Para cada fase:

1. Explique brevemente o que será alterado.
2. Faça as alterações.
3. Execute os testes.
4. Execute lint.
5. Execute typecheck.
6. Execute build quando aplicável.
7. Verifique migrations.
8. Verifique se não houve regressões.
9. Revise o diff.
10. Só então avance para a próxima fase.

Não faça uma grande alteração em centenas de arquivos de uma única vez.

Prefira alterações pequenas, isoladas e verificáveis.

## 12. GIT

Antes de grandes mudanças, verifique:

* branch atual
* status
* alterações não commitadas
* último commit

NÃO apague alterações existentes do desenvolvedor.

NÃO execute comandos destrutivos como:

git reset --hard
git clean -fd
git checkout .
git restore .

sem autorização explícita.

Organize as alterações em commits lógicos quando apropriado.

## 13. DOCUMENTAÇÃO

Se a arquitetura mudar, atualize a documentação correspondente.

Quando apropriado, crie ou atualize:

* README
* CLAUDE.md
* documentação de arquitetura
* ADRs
* documentação de APIs
* documentação de infraestrutura

## 14. REGRA CONTRA OVERENGINEERING

Não introduza complexidade apenas porque uma arquitetura parece mais sofisticada.

Não crie:

* abstrações sem necessidade
* interfaces para tudo
* microserviços sem necessidade
* design patterns sem benefício concreto
* camadas adicionais sem responsabilidade clara
* bibliotecas apenas para resolver problemas triviais

Toda mudança arquitetural deve ter uma justificativa técnica.

## 15. CRITÉRIO DE QUALIDADE

Ao final, o projeto deve apresentar:

* arquitetura mais clara
* menor acoplamento
* maior coesão
* código mais simples
* melhor testabilidade
* melhor segurança
* melhor isolamento entre tenants
* melhor observabilidade
* melhor performance quando necessário
* menor duplicação
* documentação adequada

Mas NÃO quero que você simplesmente "reescreva" o projeto.

Quero uma REFATORAÇÃO INCREMENTAL, PRESERVANDO O COMPORTAMENTO EXISTENTE.

## PRIMEIRA TAREFA

Neste momento faça SOMENTE a auditoria.

Não altere nenhum arquivo.

Entregue:

1. Resumo executivo da arquitetura atual
2. Estrutura do projeto
3. Principais problemas encontrados
4. Problemas de segurança
5. Problemas de arquitetura
6. Problemas de performance
7. Problemas de qualidade de código
8. Problemas de testes
9. Problemas de banco de dados
10. Problemas de multi-tenancy
11. Problemas de infraestrutura
12. Débitos técnicos
13. O que NÃO deve ser alterado
14. Plano de refatoração por fases
15. Ordem recomendada de execução
16. Riscos da refatoração
17. Estratégia de validação

IMPORTANTE:

Não faça nenhuma alteração até finalizar essa auditoria e apresentar o plano.
