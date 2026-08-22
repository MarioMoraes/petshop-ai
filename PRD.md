# PRD — PetShop AI
### Product Requirements Document (Documento Mestre)

| Campo | Valor |
|---|---|
| Produto | PetShop AI |
| Tipo | Micro-SaaS Multi-tenant |
| Versão do documento | 1.0 |
| Status | Rascunho para desdobramento em PRDs de módulo |
| Escopo | Visão macro — base para PRDs individuais por módulo/feature |

---

## 1. Visão Geral do Produto

**PetShop AI** é uma plataforma SaaS multi-tenant para gestão completa de petshops, clínicas veterinárias, banho & tosa e serviços correlatos. O produto nasce com um objetivo final claro — **disponibilizar agentes de inteligência artificial capazes de realizar atendimento automatizado** (agendamento, dúvidas, cobrança, relacionamento) em nome de cada petshop — mas a premissa estratégica é que **esses agentes só entregam valor real se operarem sobre uma base de dados e processos robustos, estruturados e confiáveis**.

Portanto, a primeira fase do produto é a construção da **infraestrutura operacional completa** de um petshop digital: cadastro de tutores e pets, prontuário, agenda, banho e tosa, financeiro, relacionamento/CRM e presença digital (portal e site). A camada de agentes de IA é o objetivo final do produto, mas tecnicamente é uma camada superior que consome os módulos aqui especificados.

### 1.1 Problema a ser resolvido

Petshops de pequeno e médio porte, em geral, operam com:
- Planilhas, cadernos ou sistemas legados desconectados;
- Agenda manual ou em papel, gerando conflitos e no-shows;
- Nenhum histórico clínico/comportamental estruturado do pet;
- Comunicação reativa com o tutor (sem lembretes, sem campanhas, sem automação);
- Nenhuma presença digital própria (site, portal do cliente);
- Nenhuma via de atendimento automatizado fora do horário comercial.

### 1.2 Proposta de valor

Um sistema único, multi-tenant, que unifica cadastro, prontuário, agenda, financeiro e relacionamento — e que, a partir dessa base de dados estruturada, viabiliza agentes de IA para atendimento automatizado via WhatsApp e portal do tutor, reduzindo carga operacional da equipe e aumentando recorrência e ticket médio dos clientes.

### 1.3 Nome e branding

- Nome do produto: **PetShop AI**
- Cada petshop cliente é um **tenant** com identidade visual própria (whitelabel parcial: logo, cores, subdomínio/domínio próprio para site e portal do tutor).

---

## 2. Objetivos do Produto

### 2.1 Objetivo de negócio
Lançar um Micro-SaaS verticalizado para o segmento pet, com modelo de assinatura recorrente (mensal/anual), baixo custo operacional por tenant e alta capacidade de expansão via módulos e agentes de IA como upsell.

### 2.2 Objetivos de produto (fase de infraestrutura)
1. Centralizar o cadastro de tutores e pets, incluindo dados clínicos e comportamentais.
2. Oferecer agenda operacional multiusuário (banhista, tosador, veterinário) com agendamento recorrente e online.
3. Prover controle financeiro básico por tutor (conta corrente).
4. Automatizar comunicação via WhatsApp (lembretes, aniversários, campanhas).
5. Entregar presença digital ao tenant (site institucional + portal do tutor).
6. Garantir isolamento e segurança de dados entre tenants desde o dia 1 (arquitetura multi-tenant nativa).

### 2.3 Objetivo futuro (fora do escopo funcional imediato, mas orientador da arquitetura)
Disponibilizar **agentes de IA** capazes de:
- Atender o tutor via WhatsApp/portal (dúvidas, agendamento, cancelamento, cobrança);
- Sugerir e executar campanhas de reativação;
- Atuar como triagem inicial para a equipe humana.

> Todo o PRD e SPEC devem ser desenhados considerando que os dados e APIs aqui descritos serão consumidos futuramente por agentes de IA (function calling / tools), portanto **modelagem de dados limpa e APIs bem definidas são requisito não-funcional crítico**, não apenas boa prática.

---

## 3. Público-alvo e Personas

### 3.1 Cliente (tenant) — quem compra o SaaS
- **Dono/gestor de petshop** (micro e pequena empresa, 1 a 5 unidades).
- Clínicas veterinárias com serviços de banho e tosa agregados.
- Petshops que já possuem operação, mas sem sistema de gestão digital robusto.

### 3.2 Usuários finais dentro do tenant

| Persona | Papel | Necessidades principais |
|---|---|---|
| **Administrador do tenant** | Dono/gerente | Visão consolidada, financeiro, configuração, RBAC |
| **Atendente/Recepção** | Operação de balcão | Cadastro, agenda, check-in/check-out, cobrança |
| **Banhista/Tosador** | Prestador de serviço | Agenda própria, execução de serviço, observações |
| **Veterinário** | Prestador de serviço clínico | Prontuário, histórico clínico, alergias, receituário |
| **Tutor (cliente final)** | Consumidor do serviço | Portal do tutor, agendamento online, histórico do pet |
| **Motorista Taxi Dog** | Logística leva-e-traz | Rotas, status de coleta/entrega |

---

## 4. Modelo de Negócio

- **Modelo:** SaaS multi-tenant por assinatura (mensal/anual), com possível cobrança por módulo/add-on (ex.: agentes de IA, Taxi Dog, número adicional de usuários).
- **Unidade de venda:** cada petshop = 1 tenant.
- **Planos sugeridos (a validar em PRD comercial futuro):** Starter, Pro, Enterprise — diferenciando limites de usuários, número de pets/tutores, uso de WhatsApp, site próprio e, futuramente, agentes de IA.
- **Onboarding:** self-service (cadastro do tenant, configuração inicial guiada) ou assistido, a definir.

---

## 5. Arquitetura de Negócio: Multi-tenancy

Requisitos de produto relacionados ao modelo multi-tenant (o detalhamento técnico está no SPEC):

- Cada tenant possui: dados isolados, usuários próprios, configurações próprias, integrações próprias (ex.: número de WhatsApp, domínio do site), identidade visual própria.
- Um usuário pode, em tese, pertencer a múltiplos tenants (ex.: consultor, franqueado com múltiplas unidades) — a confirmar em PRD de módulo de contas/organizações.
- Deve existir um papel de **Super Admin da plataforma** (equipe PetShop AI) com visão administrativa sobre todos os tenants, para suporte, billing e observabilidade — sem acesso indevido aos dados de negócio dos tenants (respeitando LGPD).

---

## 6. Escopo Funcional — Visão Macro dos Módulos

O sistema é organizado nos seguintes **módulos**, cada um a ser desdobrado futuramente em PRD próprio:

1. **Módulo de Identidade e Tenancy** — cadastro de tenant, usuários, papéis (RBAC), autenticação (Clerk), MFA.
2. **Módulo de Tutores** — cadastro e gestão de clientes (tutores).
3. **Módulo de Pets** — cadastro de pets, espécie/raça/porte/pelagem, álbum de fotos.
4. **Módulo de Prontuário** — histórico de atendimentos, temperamento, alergias, restrições.
5. **Módulo Financeiro do Tutor** — conta corrente (débitos/créditos), extrato, cobranças.
6. **Módulo de Agenda e Operação (Banho & Tosa / Serviços)** — agendas por profissional, recorrência, agendamento online, check-in/check-out.
7. **Módulo Taxi Dog** — logística de leva-e-traz vinculada à agenda.
8. **Módulo de Relacionamento (CRM/Automação)** — WhatsApp, lembretes, aniversários, campanhas para inativos.
9. **Módulo Portal do Tutor** — área logada do cliente final.
10. **Módulo Site do Estabelecimento** — site institucional público por tenant.
11. **Módulo de Documentos** — geração de PDFs (recibos, contratos, receituários) via Gotenberg.
12. **Módulo de Notificações/E-mail** — envio transacional via Resend.
13. **Módulo de Segurança e Compliance** — RBAC, MFA, rate limit, honeypot, LGPD.
14. **Módulo de Observabilidade e Administração da Plataforma** — logs, tracing, auditoria, dashboards, alertas (visão Super Admin).
15. **(Futuro) Módulo de Agentes de IA** — atendimento automatizado, consumindo os módulos acima via APIs internas/tools.

---

## 7. Detalhamento Funcional por Módulo

### 7.1 Módulo de Tutores

**Objetivo:** manter cadastro central de clientes (tutores), base para todo o relacionamento comercial.

Funcionalidades:
- Cadastro de tutor: nome completo, CPF/CNPJ (opcional para PJ), telefone (WhatsApp), e-mail, endereço, data de nascimento (para campanha de aniversário).
- Um tutor pode ter **múltiplos pets** vinculados.
- Histórico consolidado do tutor: pets, atendimentos, financeiro, campanhas recebidas.
- Consentimento LGPD (opt-in de comunicação, aceite de termos) registrado no cadastro.
- Busca e filtros (nome, telefone, tag/segmento).
- Tags/segmentação de tutores (ex.: VIP, inativo, inadimplente) — usada pelo módulo de relacionamento.

**Critérios de aceite de alto nível:**
- Não deve ser possível duplicar tutor pelo mesmo CPF/telefone dentro do mesmo tenant (validação de duplicidade).
- Exclusão de tutor deve respeitar regras de retenção de dados (LGPD) — soft delete + anonimização, não exclusão física imediata quando houver histórico financeiro.

---

### 7.2 Módulo de Pets

**Objetivo:** cadastro central do "paciente"/cliente animal, com metadados que padronizam operação e prontuário.

Funcionalidades:
- Cadastro de pet vinculado a um ou mais tutores (múltiplos pets por tutor; suporte a mais de um tutor responsável pelo mesmo pet, ex.: casal).
- Atributos: nome, espécie, raça, porte, pelagem, sexo, data de nascimento/idade estimada, peso, castrado (sim/não), microchip (opcional), foto principal.
- **Cadastros auxiliares (tabelas de domínio) configuráveis por tenant ou globais:**
  - Espécie (cão, gato, outros)
  - Raça (vinculada à espécie)
  - Porte (pequeno, médio, grande, gigante)
  - Pelagem (curta, longa, dupla, sem pelo, etc.)
- **Álbum de fotos do pet:** upload múltiplo, galeria cronológica, foto de capa/perfil, armazenamento via Cloudflare (Images/R2).
- Vínculo do pet ao prontuário (módulo 7.3).

**Critérios de aceite de alto nível:**
- Um pet pode ser transferido entre tutores mantendo histórico (ex.: adoção, mudança de responsável).
- Espécie/raça/porte/pelagem devem ser cadastros estruturados (não texto livre) para permitir relatórios e segmentação futura por agentes de IA.

---

### 7.3 Módulo de Prontuário

**Objetivo:** registro clínico e comportamental completo do pet, usado tanto pela equipe quanto, futuramente, por agentes de IA para triagem e recomendações.

Funcionalidades:
- **Histórico de atendimentos:** todo serviço realizado (banho, tosa, consulta, vacina, procedimento) gera um registro no prontuário, com data, profissional responsável, observações e (quando aplicável) anexos/documentos.
- **Observações de temperamento:** campo estruturado (ex.: dócil, agressivo, ansioso, medroso) + observações livres, visível à equipe operacional antes do atendimento (alerta de segurança para banhista/tosador).
- **Alergias e restrições:** cadastro estruturado de alergias (alimentares, produtos, medicamentos) que **bloqueiam ou alertam** no momento do agendamento/execução de serviços incompatíveis (ex.: impedir uso de determinado shampoo).
- Linha do tempo unificada por pet (todos os eventos em ordem cronológica).
- Anexos de exames/laudos (PDF/imagem).

**Critérios de aceite de alto nível:**
- Alergias devem gerar alerta visual obrigatório em qualquer tela de agendamento/atendimento do pet.
- Todo registro de prontuário é auditável (quem criou, quando, se foi alterado).

---

### 7.4 Módulo Financeiro do Tutor (Conta Corrente)

**Objetivo:** controle financeiro simplificado por tutor, tipo "conta corrente", para débitos (serviços, produtos) e créditos (pagamentos, pacotes pré-pagos, estornos).

Funcionalidades:
- Lançamento de débito ao concluir um serviço/venda.
- Lançamento de crédito ao registrar um pagamento.
- Saldo consolidado por tutor (positivo = crédito disponível; negativo = inadimplência).
- Extrato detalhado com filtros por período.
- Geração de recibo/comprovante em PDF (via Gotenberg).
- Base para régua de cobrança futura (integração com relacionamento/CRM).
- Suporte a pacotes/pré-pagos (ex.: pacote de 4 banhos) — a detalhar em PRD específico.

**Critérios de aceite de alto nível:**
- Todo lançamento financeiro é imutável (estorno gera novo lançamento, não edição retroativa) — trilha de auditoria.
- Este módulo **não substitui** um ERP financeiro completo (contas a pagar, DRE) — está limitado à relação tutor↔petshop nesta fase.

---

### 7.5 Módulo de Agenda — Banho, Tosa e Serviços

**Objetivo:** núcleo operacional do dia a dia do petshop.

Funcionalidades:
- **Agenda separada por profissional** (banhista, tosador, veterinário), com visualização individual e consolidada (visão "todos os profissionais do dia").
- Cadastro de serviços (tipo, duração padrão, preço, profissionais habilitados a executar).
- **Agendamento recorrente** (ex.: banho toda terça-feira) com geração automática de próximas ocorrências.
- **Agendamento online pelo tutor** via Portal do Tutor, respeitando disponibilidade real da agenda e regras do tenant (horários, bloqueios, antecedência mínima).
- Check-in (chegada do pet) e check-out (conclusão/entrega), com atualização de status em tempo real.
- Bloqueio de horários/folgas por profissional.
- Alertas de conflito de agenda e de alergia/restrição do pet no momento do agendamento.
- **Lembrete automático por WhatsApp** antes do agendamento (módulo de relacionamento, mas disparado a partir de eventos de agenda).

**Critérios de aceite de alto nível:**
- Overbooking não deve ocorrer para o mesmo profissional/horário, salvo configuração explícita do tenant.
- Cancelamento/reagendamento deve respeitar política configurável (ex.: até X horas antes).

---

### 7.6 Módulo Taxi Dog

**Objetivo:** gerenciar o serviço de leva-e-traz vinculado a um agendamento.

Funcionalidades:
- Solicitação de Taxi Dog associada a um agendamento (ida, volta, ou ambos).
- Definição de janela de coleta/entrega e endereço (herdado do tutor ou informado na hora).
- Atribuição a um motorista/veículo.
- Atualização de status (a caminho, coletado, em rota, entregue).
- Notificação automática ao tutor em cada mudança de status relevante (via WhatsApp).

**Critérios de aceite de alto nível:**
- Taxi Dog é um **serviço complementar** vinculado à agenda, não uma agenda independente — deve respeitar o horário do serviço principal.

---

### 7.7 Módulo de Relacionamento e Inteligência (CRM/Automação)

**Objetivo:** aumentar recorrência e engajamento do tutor via comunicação automatizada, e preparar a base de eventos que futuramente alimentará os agentes de IA.

Funcionalidades:
- **Integração com WhatsApp** (API oficial/BSP) por tenant — número próprio ou compartilhado, a definir.
- **Lembrete automático de agendamento** via WhatsApp (D-1, ou configurável).
- **Aniversário do pet e do tutor:** disparo automático de mensagem de parabéns, possivelmente com cupom/benefício.
- **Campanha para clientes inativos:** segmentação automática de tutores sem atendimento há X dias, com disparo de campanha de reativação (mensagem + oferta).
- Histórico de todas as comunicações enviadas por tutor (auditável).
- Base de templates de mensagem configuráveis por tenant.

**Critérios de aceite de alto nível:**
- Todo envio deve respeitar opt-in/opt-out do tutor (LGPD).
- Falhas de envio devem ser registradas e visíveis em dashboard operacional.

---

### 7.8 Módulo Portal do Tutor

**Objetivo:** self-service para o cliente final.

Funcionalidades:
- Login do tutor (Clerk), vinculado ao tenant.
- Visualização dos pets, prontuário resumido (histórico de serviços), fotos.
- Agendamento online (integrado ao módulo 7.5).
- Visualização de extrato financeiro (conta corrente) e recibos.
- Atualização de dados cadastrais próprios e dos pets.
- Central de comunicação (histórico de mensagens recebidas, preferências de notificação).

---

### 7.9 Módulo Site do Estabelecimento (Tenant)

**Objetivo:** presença digital pública de cada petshop, gerada a partir dos dados do tenant.

Funcionalidades:
- Site institucional público (landing) por tenant: informações, serviços, endereço, horário, contato, botão de agendamento (leva ao Portal do Tutor).
- Domínio próprio ou subdomínio (ex.: `petshopdojoao.petshopai.com`), gerenciado via Cloudflare.
- Customização visual básica (logo, cores, textos) — identidade do tenant.
- SEO básico (meta tags, sitemap).

---

### 7.10 Módulo de Documentos (Geração de PDF)

**Objetivo:** gerar documentos formais a partir de dados do sistema.

Funcionalidades:
- Geração de recibos de pagamento.
- Geração de comprovantes de agendamento.
- Geração de receituário/laudo veterinário (quando aplicável).
- Geração de contratos/termos (ex.: termo de responsabilidade, autorização de uso de imagem).
- Motor de geração: **Gotenberg** (HTML/templates → PDF).

---

### 7.11 Módulo de Notificações Transacionais (E-mail)

**Objetivo:** comunicação transacional via e-mail (fora do escopo do WhatsApp).

Funcionalidades:
- E-mail de boas-vindas/onboarding do tenant e do usuário.
- Confirmação de agendamento (complementar ao WhatsApp).
- Recuperação de senha/verificação (fluxo Clerk, quando aplicável).
- Envio de recibos/notas por e-mail.
- Motor de envio: **Resend**.

---

### 7.12 Módulo de Segurança e Compliance

Funcionalidades voltadas ao produto (o detalhamento técnico está no SPEC, seção de Segurança):
- RBAC configurável por tenant (papéis padrão + customização, a validar).
- MFA obrigatório para papéis administrativos.
- Registro de consentimento LGPD por titular de dados (tutor).
- Exportação e exclusão de dados a pedido do titular (direitos LGPD).
- Honeypot em formulários públicos (site, cadastro, portal) contra bots.

---

### 7.13 Módulo de Observabilidade e Administração da Plataforma

**Objetivo:** visão operacional da plataforma como um todo, para a equipe PetShop AI (Super Admin) e, em nível de tenant, para o administrador local.

Funcionalidades:
- Dashboard de saúde da plataforma (uptime, erros, filas de WhatsApp/e-mail).
- Auditoria de ações sensíveis (quem fez o quê, quando) por tenant.
- Alertas configuráveis (falhas de integração, filas travadas, uso anômalo).
- Painel de billing/uso por tenant (para operação comercial do SaaS).

---

### 7.14 (Visão Futura) Módulo de Agentes de IA

Fora do escopo de construção imediata, mas **orientador de arquitetura**. Funcionalidades previstas:
- Agente de atendimento via WhatsApp: responde dúvidas, realiza agendamento, consulta status, informa saldo/extrato.
- Agente de triagem: coleta sintomas/comportamento antes de consulta veterinária, alimentando o prontuário.
- Agente de relacionamento: sugere e, mediante aprovação, dispara campanhas de reativação personalizadas.
- Requisito de arquitetura: todos os módulos acima devem expor **APIs internas estáveis e bem documentadas** (contratos claros de entrada/saída) para servirem como *tools* de function calling desses agentes.

---

## 8. Integrações Externas (visão de produto)

| Integração | Uso no produto |
|---|---|
| **Clerk** | Autenticação e gestão de usuários/organizações (tenants), MFA, SSO futuro |
| **Cloudflare API** | DNS/domínios dos sites de tenant, CDN, proteção (WAF/Bot Management), armazenamento de imagens |
| **Resend** | Envio de e-mails transacionais |
| **Gotenberg** | Geração de PDFs (recibos, contratos, receituários) |
| **WhatsApp (API/BSP)** | Lembretes, campanhas, aniversários, futura camada de agentes |

---

## 9. Requisitos Não-Funcionais (visão de produto)

- **Multi-tenancy nativo** com isolamento total de dados entre petshops.
- **LGPD by design:** consentimento, portabilidade, direito ao esquecimento.
- **Disponibilidade** compatível com operação comercial (petshop opera em horário comercial, mas portal/site devem ter alta disponibilidade 24/7).
- **Auditabilidade** de toda ação sensível (financeiro, prontuário, dados pessoais).
- **Extensibilidade:** arquitetura deve permitir novos módulos (ex.: agentes de IA) sem retrabalho estrutural.
- **Performance percebida:** telas operacionais (agenda, check-in) devem responder de forma quase instantânea, pois são usadas em balcão com cliente presente.

---

## 10. Roadmap de Alto Nível (sugerido)

| Fase | Escopo |
|---|---|
| **Fase 0 — Fundação** | Multi-tenancy, autenticação (Clerk), RBAC, estrutura do monorepo, observabilidade base |
| **Fase 1 — Cadastros Core** | Tutores, Pets, cadastros auxiliares (espécie/raça/porte/pelagem), álbum de fotos |
| **Fase 2 — Prontuário e Financeiro** | Histórico de atendimentos, temperamento, alergias, conta corrente |
| **Fase 3 — Agenda e Operação** | Agenda por profissional, recorrência, check-in/out, Taxi Dog |
| **Fase 4 — Relacionamento** | WhatsApp, lembretes, aniversários, campanhas de inativos |
| **Fase 5 — Presença Digital** | Portal do Tutor, Site do Estabelecimento, agendamento online |
| **Fase 6 — Documentos e Notificações** | Gotenberg (PDFs), Resend (e-mails) |
| **Fase 7 — Segurança e Compliance avançada** | MFA, honeypot, auditoria completa, LGPD end-to-end |
| **Fase 8 — Agentes de IA** | Camada de atendimento automatizado sobre a base construída |

---

## 11. Métricas de Sucesso (KPIs candidatos)

- Nº de tenants ativos / MRR.
- Taxa de churn de tenants.
- % de agendamentos feitos via Portal do Tutor (self-service) vs. balcão.
- Taxa de no-show (antes e depois dos lembretes automáticos).
- Taxa de reativação de clientes inativos via campanha.
- Tempo médio de atendimento no balcão (check-in → check-out).
- NPS do tutor (portal) e do administrador do tenant.

---

## 12. Riscos e Premissas

**Riscos:**
- Dependência de API oficial de WhatsApp (custos, aprovação, limites de mensageria).
- Complexidade de isolamento multi-tenant crescendo junto com número de microserviços.
- Adoção pelo público-alvo (petshops pequenos, possivelmente pouco digitalizados) — exige onboarding simples.
- Regulação LGPD envolvendo dados de terceiros (tutores) tratados por cada tenant.

**Premissas:**
- Cada tenant é uma petshop única (não multi-loja na v1; multi-unidade fica para fase futura, a validar).
- O idioma e mercado inicial é o Brasil (moeda BRL, LGPD, WhatsApp como canal primário).
- A camada de agentes de IA será especificada em PRD/SPEC próprios quando os módulos base estiverem estáveis.

---

## 13. Glossário

- **Tenant:** instância isolada de uma petshop dentro da plataforma.
- **Tutor:** cliente humano responsável por um ou mais pets.
- **Prontuário:** registro histórico clínico/comportamental do pet.
- **Conta Corrente:** saldo de débitos/créditos do tutor junto ao tenant.
- **Taxi Dog:** serviço de leva-e-traz do pet.
- **BSP:** Business Solution Provider (provedor oficial de API do WhatsApp).
- **RBAC:** Role-Based Access Control.
- **MFA:** Multi-Factor Authentication.

---

## 14. Próximos Passos

Este PRD é o documento-mãe. A partir dele, devem ser criados PRDs individuais por módulo (listados na seção 6), cada um detalhando: histórias de usuário, critérios de aceite completos (Gherkin/BDD), wireframes/fluxos e regras de negócio específicas. O SPEC.md (documento irmão) detalha a arquitetura técnica que sustenta este escopo.
