# PRD Detalhado — Site do Estabelecimento

**Módulo:** MOD-SITE
**Arquivo:** 10/15
**Prioridade:** P1
**Fase de Implementação:** Fase 5 — Presença Digital
**Serviço Backend:** `tenant-site-service` (porta 3013) + rotas públicas no `frontend` (Next.js, SSR/ISR)
**Tabelas Principais:** `site_settings`, `site_photos`, `site_leads` (novas), `tenant_settings` (ganha endereço público), `tenants` (ganha domínio próprio, modelado)
**Data:** 2026-08-28
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** O PRD-mãe §27 lista, entre as dores do petshop brasileiro, "nenhuma presença digital própria". Na prática isso significa que o petshop existe no Google como um pino no mapa com três avaliações e um telefone que ninguém atende no sábado — e que a pergunta "vocês abrem domingo?" chega por WhatsApp cinco vezes por semana. O site do estabelecimento resolve isso com um material que o sistema **já tem inteiro**: o nome, o logo, as cores, os serviços, os preços, o horário de funcionamento. Nenhum petshop vai contratar um desenvolvedor para publicar essas seis coisas, e nenhum vai manter um site que exija manutenção. O módulo entrega a página que nasce pronta no dia do onboarding e se atualiza sozinha quando o petshop muda o horário no Admin.

**Integração sistêmica.** Upstream: **MOD-IDENT** (nome, slug, identidade visual, horário de funcionamento, e o endereço público que este módulo acrescenta), **MOD-AGENDA** (catálogo de serviços e a tabela de preços de onde sai o "a partir de"), **MOD-TUTOR** (destino da conversão de lead). Downstream: **MOD-PORTAL** (o botão "agendar" do site desemboca no Portal — é o par natural deste módulo, e a razão de os dois estarem na mesma fase), **MOD-CRM** (o lead convertido entra nas automações como qualquer tutor), **MOD-ADMIN** (a fila de leads e a saúde da publicação), **MOD-AI** (a página é uma das fontes que o agente cita quando responde "vocês abrem domingo?").

**O que este módulo acrescenta ao sistema, e não só ao site.** Três lacunas do modelo aparecem quando se tenta montar a página, e nenhuma delas é problema do site — são dados que faltam ao produto inteiro. **(1) O tenant não tem endereço.** Há `legal_name` e CNPJ cifrado, há endereço de tutor e há zonas de taxi por faixa de CEP, mas o petshop em si não tem rua, número nem cidade em lugar nenhum do schema. Sem isso não há site, não há mapa, não há SEO local e não há cabeçalho de recibo com o endereço de quem emitiu. **(2) O tenant não tem telefone público.** O WhatsApp do estabelecimento é configuração do MOD-CRM, voltada a disparo, não a exibição. **(3) O `Tenant` não tem campo de domínio** — só `slug`. Este PRD modela os três; o terceiro fica modelado e não implementado (§ MOD-SITE-12).

**Escopo da v1.** Entram as doze sub-features do §2, com a décima segunda **especificada e não construída**. Ficam de fora: blog ou conteúdo editorial, loja/e-commerce (o produto não vende produto), avaliações e depoimentos (exigem moderação, e depoimento inventado é passivo), integração com Google Meu Negócio, e multi-idioma.

---

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-SITE-01 | Publicação | Ligar e desligar o site; endereço público pelo slug | Must Have |
| MOD-SITE-02 | Endereço e Contato | Endereço físico, telefone e WhatsApp públicos do estabelecimento | Must Have |
| MOD-SITE-03 | Identidade e Textos | Logo, cores e os poucos textos livres da página | Must Have |
| MOD-SITE-04 | Galeria | Fotos do estabelecimento e da equipe | Should Have |
| MOD-SITE-05 | Vitrine de Serviços | Serviços ativos com "a partir de R$ X" | Must Have |
| MOD-SITE-06 | Horário de Funcionamento | Renderizado do `business_hours` que já existe | Must Have |
| MOD-SITE-07 | Chamadas para Ação | Agendar (leva ao Portal), WhatsApp, telefone, rota no mapa | Must Have |
| MOD-SITE-08 | Captação de Lead | Formulário público com honeypot e rate limit | Should Have |
| MOD-SITE-09 | Fila de Leads | Tratamento no Admin e conversão em tutor num clique | Should Have |
| MOD-SITE-10 | SEO | Metadados, Open Graph, `sitemap.xml`, `robots.txt`, JSON-LD | Must Have |
| MOD-SITE-11 | Entrega e Revalidação | Roteamento por host, ISR e invalidação por evento | Must Have |
| MOD-SITE-12 | Domínio Próprio | Modelado e especificado; **não implementado na v1** | Nice to Have |

---

## 3. Critérios de Aceite

### [MOD-SITE-01] — Publicação

> **Decisão de produto (2026-08-28): template fixo alimentado pelos dados.** Não há editor de blocos. A página nasce montada do que o tenant já cadastrou e o admin edita três ou quatro textos livres. O motivo é o comportamento real do cliente: um petshop de cinco pessoas não vai "montar uma página", e um editor de blocos entregue a quem não é designer produz um site pior que o template. O que se ganha em flexibilidade se perde em site publicado.

**AC-01 (Happy Path)**
- **Dado** um tenant que concluiu o onboarding
- **Quando** o admin abre Configurações → Site e clica em "Publicar"
- **Então** `site_settings.published = true`, `published_at` é gravado, publica-se `site.publicado`, e `https://{slug}.{dominio}` passa a responder **200** com a página montada; **200**

**AC-02 (Validação / Erro — dados mínimos ausentes)**
- **Dado** um tenant sem endereço público preenchido
- **Quando** tenta publicar
- **Então** **422** `ERR_SITE_001` listando o que falta: endereço, telefone de contato e ao menos um serviço ativo. Publicar uma página que não diz onde o petshop fica é pior que não ter página — quem chega nela conclui que o negócio não existe mais

**AC-03 (Happy Path — despublicar)**
- **Dado** um site no ar
- **Quando** o admin despublica
- **Então** a rota passa a responder **404** (não 403, não uma página de "em construção"), o cache é invalidado imediatamente e publica-se `site.despublicado`

**AC-04 (Edge Case — tenant suspenso ou em trial vencido)**
- **Dado** um tenant com `status` diferente de `ACTIVE`
- **Quando** a página é requisitada
- **Então** **404**, independentemente de `published`. O site é entrega comercial e acompanha o estado da conta; e uma página no ar de um cliente que parou de pagar é a pior propaganda possível do produto

**AC-05 (Edge Case — slug reservado ou inexistente)**
- **Dado** um host cujo subdomínio não corresponde a nenhum tenant, ou corresponde a um slug reservado da plataforma (`app`, `api`, `www`, `admin`)
- **Quando** a página é requisitada
- **Então** **404** com a página institucional do produto, nunca um erro cru. A lista de slugs reservados já existe no identity-service (`ERR_IDENT_002`) e é a mesma aqui

---

### [MOD-SITE-02] — Endereço e Contato do Estabelecimento

> Dado novo no sistema, e com uma diferença importante em relação ao endereço do tutor: **o endereço do petshop não é cifrado**. O do tutor é residencial e vive em `tutor_addresses` com logradouro em AES-256-GCM, porque é dado pessoal. O do estabelecimento é comercial, e o módulo inteiro existe para **publicá-lo na internet** — cifrar seria teatro.

**AC-01 (Happy Path)**
- **Dado** o admin preenchendo o endereço
- **Quando** informa o CEP
- **Então** o ViaCEP (o mesmo porta injetável do MOD-TUTOR) completa logradouro, bairro, cidade e UF, restando número e complemento; **200**

**AC-02 (Happy Path — mapa)**
- **Dado** um endereço completo
- **Quando** é salvo
- **Então** o site passa a exibir o botão "como chegar", montado como link de mapa a partir do endereço textual. **Não** há geocodificação nem chave de API de mapas na v1: latitude e longitude ficam no modelo, opcionais e vazias, para quando houver

**AC-03 (Validação / Erro)**
- **Dado** um CEP inválido ou um número ausente
- **Quando** o admin salva
- **Então** **422** `ERR_SITE_002` com o campo apontado. UF e cidade são validados contra a resposta do ViaCEP, não contra digitação livre

**AC-04 (Edge Case — telefone público diferente do WhatsApp de disparo)**
- **Dado** um petshop com um fixo para atendimento e um celular para o WhatsApp
- **Quando** preenche os dois
- **Então** são dois campos distintos, e o site mostra os dois. O número do MOD-CRM é o que **envia**; este é o que o cliente **liga**. Amarrar os dois obrigaria a operação a escolher entre disparar e atender pelo mesmo aparelho

---

### [MOD-SITE-03] — Identidade Visual e Textos

**AC-01 (Happy Path)**
- **Dado** o tenant com `branding` preenchido no onboarding (logo, cor primária, cor secundária)
- **Quando** o site é montado
- **Então** a paleta da página deriva dessas cores, sem o admin escolher nada a mais. O `BrandingSchema` já existe e é o mesmo do Admin e do Portal — uma identidade, três superfícies

**AC-02 (Happy Path — textos livres)**
- **Dado** o admin editando o site
- **Quando** preenche os textos
- **Então** existem exatamente quatro campos, todos opcionais e todos com padrão gerado do cadastro: **chamada** (até 120 caracteres), **sobre nós** (até 800), **aviso** (faixa temporária, até 200 — "fechados dia 25") e **legenda do rodapé**. Quatro é escolha, não limitação: cada campo a mais é um campo que fica desatualizado

**AC-03 (Validação / Erro — HTML no texto)**
- **Dado** um texto contendo marcação
- **Quando** é salvo
- **Então** é aceito como **texto puro** e escapado na renderização. Não há editor rico, não há HTML do usuário na página, e portanto não há XSS armazenado a defender. O `<b>` que o admin digitar aparece literalmente, e isso é a resposta certa

**AC-04 (Edge Case — contraste ilegível)**
- **Dado** um tenant com cor primária muito clara
- **Quando** a página é montada
- **Então** o texto sobre a cor é escolhido entre claro e escuro pelo cálculo de luminância, não fixado no template. Um petshop com identidade amarela não pode receber um site com texto branco sobre amarelo

---

### [MOD-SITE-04] — Galeria

**AC-01 (Happy Path)**
- **Dado** o admin subindo fotos do salão e da equipe
- **Quando** o upload conclui
- **Então** as imagens vão para o R2 no caminho segregado por tenant (SPEC §214), com redimensionamento e limite iguais aos do álbum do pet (MOD-PET-08), e entram em `site_photos` com posição ordenável; **201**

**AC-02 (Validação / Erro — limite)**
- **Dado** uma galeria com 12 fotos
- **Quando** o admin sobe a décima terceira
- **Então** **422** `ERR_SITE_003`. O teto é de produto: uma página de petshop com 40 fotos é uma página que ninguém rola até o fim e que demora a carregar no 4G da calçada

**AC-03 (Edge Case — foto de pet de cliente)**
- **Dado** o admin querendo usar a foto de um pet atendido
- **Quando** vai subir
- **Então** o formulário exibe o aviso de que publicar imagem de pet de cliente exige autorização do tutor, e a origem da foto **não** é o álbum do MOD-PET: é upload novo e deliberado. Reaproveitar `pet_photos` na página pública transformaria consentimento de guarda em consentimento de publicação, que são coisas diferentes

---

### [MOD-SITE-05] — Vitrine de Serviços

> **Decisão de produto (2026-08-28): faixa "a partir de R$ X".** Preço exato depende de porte e pelagem e o site não sabe qual é o pet; tabela completa publicada entrega a grade inteira ao concorrente; nenhum preço mantém no telefone a pergunta que o site deveria responder. A faixa é o padrão do setor e o meio-termo honesto.

**AC-01 (Happy Path)**
- **Dado** os serviços ativos do tenant com tabela de preços por porte
- **Quando** a vitrine é montada
- **Então** cada serviço aparece com nome, descrição e **`MIN(service_pricing.price_cents)`** rotulado como "a partir de", com a ressalva de que o valor final depende do porte e do tipo de pelo; **200**

**AC-02 (Edge Case — serviço sem preço cadastrado)**
- **Dado** um serviço ativo sem nenhuma linha em `service_pricing`
- **Quando** a vitrine é montada
- **Então** ele aparece **sem** faixa de preço, com "consulte" — e não some. Sumir esconderia do cliente um serviço que o petshop presta

**AC-03 (Edge Case — categoria TAXI)**
- **Dado** o serviço-âncora do Taxi Dog, categoria `TAXI`
- **Quando** a vitrine é montada
- **Então** ele **não** entra na lista de serviços agendáveis — a mesma regra do seletor de agendamento, que usa `BOOKABLE_SERVICE_CATEGORIES`. O leva-e-traz aparece como um destaque à parte ("buscamos e levamos seu pet"), quando `taxi_settings.enabled`

**AC-04 (Edge Case — controle do admin)**
- **Dado** um serviço que o petshop presta mas não quer anunciar
- **Quando** o admin desmarca "mostrar no site"
- **Então** ele sai da vitrine e continua agendável no balcão. A vitrine é subconjunto do catálogo, não espelho dele

---

### [MOD-SITE-06] — Horário de Funcionamento

**AC-01 (Happy Path)**
- **Dado** o `business_hours` configurado no onboarding
- **Quando** a página é montada
- **Então** o horário é renderizado com dias agrupados ("Seg a Sex, 8h–18h; Sáb, 8h–13h; Dom, fechado") e um selo de **aberto agora / fechado**, calculado no fuso do tenant. Nenhum campo novo: é o mesmo dado que a agenda usa para saber quando há vaga

**AC-02 (Edge Case — mudou o horário no Admin)**
- **Dado** o admin alterando o horário em Configurações
- **Quando** salva
- **Então** o site reflete a mudança sem ninguém tocar no site — via a revalidação do MOD-SITE-11. É a promessa central do template alimentado por dados: **não existe uma segunda cópia do horário para manter**

**AC-03 (Edge Case — o selo mente ao redor da virada)**
- **Dado** um visitante às 17h58 num dia que fecha às 18h
- **Quando** a página vem do cache
- **Então** o selo "aberto agora" é calculado **no cliente**, a partir do `business_hours` e do fuso embarcados na página, e não no servidor. Um selo renderizado no servidor e servido de cache por dez minutos diz "aberto" para quem chega às 18h05

---

### [MOD-SITE-07] — Chamadas para Ação

**AC-01 (Happy Path)**
- **Dado** um tenant com `portal_enabled` e `online_booking_enabled`
- **Quando** o visitante clica em "Agendar"
- **Então** vai para o Portal do Tutor (MOD-PORTAL), que pede o acesso dele. É o encontro dos dois módulos da Fase 5, e a razão de o §7.9 do PRD-mãe descrever o botão como "leva ao Portal do Tutor"

**AC-02 (Edge Case — agendamento online desligado)**
- **Dado** `online_booking_enabled = false`
- **Quando** a página é montada
- **Então** o botão principal vira "Falar no WhatsApp", e não um "Agendar" que leva a uma porta fechada. A página se reconfigura conforme o que o tenant realmente oferece

**AC-03 (Happy Path — contato direto)**
- **Dado** o telefone e o WhatsApp públicos
- **Quando** o visitante está no celular
- **Então** o telefone é `tel:` e o WhatsApp é `wa.me` com uma mensagem inicial preenchida com o nome do petshop. A maior parte do tráfego chega de celular, e um número que não disca é um número que não serve

---

### [MOD-SITE-08] — Captação de Lead

> **Decisão de produto (2026-08-28): o formulário vira lead no sistema.** A alternativa (só botões de contato) não deixa rastro nenhum de quantas pessoas quiseram falar e desistiram. O SPEC §195 já exigia honeypot em "formulários públicos do site do tenant", o que pressupõe que existe um.

**AC-01 (Happy Path)**
- **Dado** um visitante preenchendo nome, telefone e mensagem
- **Quando** envia
- **Então** grava-se `site_leads` com `status = NEW`, publica-se `lead.recebido`, a equipe recebe aviso pelo messaging-service e a página confirma o envio; **201**

**AC-02 (Validação / Erro — honeypot)**
- **Dado** o campo oculto preenchido por um bot
- **Quando** o envio chega
- **Então** a resposta é **201, idêntica à do sucesso**, e nada é gravado. Responder com erro ensina o bot a contornar — é a mesma regra do MOD-PORTAL-11

**AC-03 (Edge Case — rate limit)**
- **Dado** o mesmo IP enviando
- **Quando** passa de 3 envios em 15 minutos
- **Então** **429** `ERR_SITE_004`. Formulário público sem teto é caixa de spam com custo de banco

**AC-04 (Edge Case — o lead já é cliente)**
- **Dado** um telefone que casa com `tutors.phone_hash` do tenant
- **Quando** o lead é gravado
- **Então** a linha nasce marcada como "já é cliente", com o vínculo ao tutor existente. A equipe precisa saber que não é aquisição — é um cliente que não achou o WhatsApp. A checagem usa o mesmo `hashSearchable` do MOD-TUTOR e **não** revela nada ao visitante

**AC-05 (Edge Case — conteúdo mínimo)**
- **Dado** uma mensagem com menos de 3 caracteres ou um telefone que não é telefone brasileiro
- **Quando** enviado
- **Então** **422** `ERR_SITE_005`. Lead sem telefone válido é linha que ninguém consegue trabalhar

---

### [MOD-SITE-09] — Fila de Leads no Admin

**AC-01 (Happy Path)**
- **Dado** leads recebidos
- **Quando** a recepção abre a fila
- **Então** vê nome, telefone, mensagem, data e status, com os `NEW` no topo; **200** (permissão `site:manage`)

**AC-02 (Happy Path — conversão)**
- **Dado** um lead que virou cliente
- **Quando** a recepção clica em "criar tutor"
- **Então** abre o cadastro do MOD-TUTOR pré-preenchido; concluído, o lead vai a `CONVERTED` com `converted_tutor_id`, e publica-se `lead.convertido`. A conversão exige `tutor:create` — ver leads e criar tutor são permissões diferentes, e o módulo não contorna a matriz

**AC-03 (Edge Case — duplicata na conversão)**
- **Dado** um lead cujo telefone já pertence a um tutor
- **Quando** a conversão é tentada
- **Então** cai na detecção de duplicata que o MOD-TUTOR já tem (**409** com `candidates`), e a recepção vincula ao existente em vez de criar outro

**AC-04 (Edge Case — descarte e retenção)**
- **Dado** um lead sem retorno
- **Quando** é descartado, ou completa 12 meses em `NEW`
- **Então** vai a `DISCARDED`, e o job `site-leads-retention` **apaga** nome, telefone e mensagem dos descartados com mais de 12 meses, mantendo a linha com metadados para estatística. Guardar dado de quem nunca virou cliente, indefinidamente, é passivo sem finalidade — o mesmo raciocínio da retenção de mensagens do MOD-CRM

---

### [MOD-SITE-10] — SEO

**AC-01 (Happy Path)**
- **Dado** um site publicado
- **Quando** um buscador o visita
- **Então** recebe HTML renderizado no servidor (não um esqueleto hidratado no cliente), `<title>` e `<meta description>` derivados do nome, cidade e serviços, `canonical` apontando para o host oficial do tenant, e Open Graph com o logo ou a primeira foto da galeria

**AC-02 (Happy Path — dados estruturados)**
- **Dado** a mesma página
- **Quando** é lida
- **Então** traz JSON-LD do tipo `LocalBusiness`/`PetStore` com nome, endereço, telefone, horário e faixa de preço. É o que permite ao buscador mostrar horário e endereço direto no resultado — e é a razão prática de o MOD-SITE-02 existir

**AC-03 (Happy Path — sitemap e robots)**
- **Dado** o host do tenant
- **Quando** `/sitemap.xml` e `/robots.txt` são requisitados
- **Então** respondem por tenant: sitemap com as rotas públicas daquele site, e robots liberando o site público e **bloqueando** todo o caminho autenticado (`/portal`, `/dashboard`, `/agenda`…)

**AC-04 (Edge Case — site despublicado ou tenant inativo)**
- **Dado** um site fora do ar
- **Quando** o buscador visita
- **Então** **404** e `X-Robots-Tag: noindex`. Página despublicada que continua indexada é pior que nunca ter existido

**AC-05 (Edge Case — o admin quer escrever o próprio título)**
- **Dado** um admin que sabe o que quer aparecer no Google
- **Quando** preenche título e descrição de SEO
- **Então** eles substituem os derivados, com limite de 60 e 160 caracteres e o aviso de corte. Campo vazio volta ao derivado — nunca fica em branco

---

### [MOD-SITE-11] — Entrega e Revalidação

> **Decisão de arquitetura herdada do SPEC §33:** o site público **não é um app novo no monorepo**. É uma capacidade do `frontend` Next.js, com rotas multi-tenant resolvidas por host e renderização SSR/ISR para SEO (SPEC §37). O `tenant-site-service:3013` guarda e serve o **conteúdo e a configuração**; quem renderiza é o frontend que já está no ar. Na implantação atual isso significa **nenhum container novo** — o Caddy já entrega `*.{$APP_DOMAIN}` ao `frontend:3002`.

**AC-01 (Happy Path — roteamento por host)**
- **Dado** uma requisição a `petshopdojoao.{dominio}`
- **Quando** chega ao Next
- **Então** o subdomínio resolve o tenant e a rota pública é servida **sem** exigir autenticação
>
> **Decisão de 2026-08-28:** o site fica na **raiz** do host do tenant, o Portal do
> Tutor em `/portal` na mesma origem, e o Admin da equipe muda para `app.{dominio}`.
> A raiz é do site porque SEO local não compete bem em subpasta; o Admin sai porque o
> cookie de sessão da equipe não deve dividir origem com a superfície mais exposta do
> sistema. Ver o §5 de `portal_tutor_09.md`.

**AC-02 (Validação / Erro — a mudança no middleware)**
- **Dado** que o `middleware.ts` hoje redireciona ao login **tudo** que não seja `/sign-in`, `/sign-up` e `/api/health`
- **Quando** o site público entra no ar
- **Então** a decisão passa a ser **por host antes de por rota**: host de tenant com site publicado é público por inteiro; o host da aplicação continua exatamente como está. Inverter a ordem é a mudança estrutural desta sub-feature, e é a que mais precisa de teste — um erro aqui ou expõe o Admin, ou tranca o site atrás de um login

**AC-03 (Happy Path — ISR e revalidação por evento)**
- **Dado** o site em cache com revalidação periódica
- **Quando** chega `tenant.configuracao.atualizada`, `servico.atualizado` ou `site.publicado`
- **Então** o consumidor dispara revalidação sob demanda daquele host, e a página reflete a mudança em segundos. Sem isso, o horário corrigido às 9h aparece ao meio-dia — e o AC-02 do MOD-SITE-06 vira mentira
>
> **Dependência que não existe ainda:** o scheduling-service publica `agendamento.*` e `atendimento.*`, e **nada** quando o catálogo de serviços muda — não há `servico.criado`, `servico.atualizado` nem `servico.removido` no sistema. O MOD-SITE precisa que o MOD-AGENDA passe a publicá-los; enquanto não publicar, a vitrine se atualiza só pelo TTL de 10 minutos. É a única dependência deste módulo em código de terceiro, e vale abrir com o MOD-AGENDA antes da fatia 2.

**AC-04 (Edge Case — o serviço de conteúdo cai)**
- **Dado** o `tenant-site-service` indisponível
- **Quando** uma página em cache é requisitada
- **Então** ela **continua sendo servida** do cache (stale-while-revalidate). O site é a superfície com SLO de 24/7 (PRD-mãe §357) enquanto o petshop opera em horário comercial; ele não pode cair junto com o resto

**AC-05 (Edge Case — mídia e cabeçalhos)**
- **Dado** a página pública
- **Quando** é servida
- **Então** herda os cabeçalhos de segurança que o Caddy já aplica (HSTS, `nosniff`, `Referrer-Policy`) e acrescenta uma CSP própria da superfície pública — mais restritiva que a do Admin, porque aqui não há SDK de terceiro a acomodar além das imagens do R2

---

### [MOD-SITE-12] — Domínio Próprio *(modelado, não implementado na v1)*

> **Decisão de produto (2026-08-28): só subdomínio na v1.** `petshopdojoao.{dominio}` funciona hoje sem tocar em infraestrutura — o wildcard DNS-01 da Cloudflare no Caddy já emite o certificado. Domínio próprio exige TLS sob demanda (`on_demand_tls` com endpoint de autorização), verificação de posse, automação da API da Cloudflare e um estado de domínio a operar. É uma frente comparável ao resto do módulo somado, e não é o que separa o piloto de funcionar.

**AC-01 (o que fica pronto na v1)**
- **Dado** este PRD
- **Quando** a v1 é implementada
- **Então** `tenants.custom_domain`, `custom_domain_status` e `custom_domain_verified_at` **existem no schema**, sempre nulos, e a resolução por host já consulta o campo antes de cair no slug. O código não precisa mudar de forma quando o recurso chegar

**AC-02 (o fluxo especificado, para quando entrar)**
- **Dado** um admin informando `petshopdojoao.com.br`
- **Quando** salva
- **Então** o estado vai a `PENDING`, a tela mostra o registro DNS a criar (um `CNAME` para o host da plataforma e um `TXT` de posse), e um job verifica periodicamente. Verificado, vai a `ACTIVE`; o Caddy emite o certificado por HTTP-01 sob demanda, autorizando **apenas** hosts em `ACTIVE` — sem essa autorização, qualquer um aponta um domínio para o IP e faz a borda emitir certificado para ele

**AC-03 (o que não muda)**
- **Dado** um tenant com domínio próprio ativo
- **Quando** alguém acessa pelo subdomínio antigo
- **Então** ele **continua respondendo**, com `redirect` 301 para o domínio próprio e `canonical` apontando para lá. O slug está impresso em QR code (é a razão de ele ser imutável no Admin), e um QR impresso não se atualiza

---

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| `site_settings` **(nova)** | `tenant_id` | UUID | ✓ | PK e FK — um site por tenant |
| `site_settings` | `published` | Boolean | ✓ | Default `false` |
| `site_settings` | `published_at` | Timestamptz | — | Primeira publicação |
| `site_settings` | `headline` | VarChar(120) | — | Chamada; padrão derivado do nome |
| `site_settings` | `about` | VarChar(800) | — | "Sobre nós" |
| `site_settings` | `notice` | VarChar(200) | — | Faixa temporária ("fechados dia 25") |
| `site_settings` | `footer_note` | VarChar(200) | — | Legenda do rodapé |
| `site_settings` | `show_prices` | Boolean | ✓ | Default `true` — a faixa "a partir de" |
| `site_settings` | `lead_form_enabled` | Boolean | ✓ | Default `true` |
| `site_settings` | `seo_title` | VarChar(60) | — | Sobrescreve o derivado |
| `site_settings` | `seo_description` | VarChar(160) | — | Idem |
| `site_settings` | `og_image_url` | Text | — | Padrão: logo ou primeira foto |
| `site_photos` **(nova)** | `id` / `tenant_id` | UUID | ✓ | PK / RLS |
| `site_photos` | `url` | Text | ✓ | R2, caminho segregado por tenant |
| `site_photos` | `alt` | VarChar(120) | — | Acessibilidade e SEO de imagem |
| `site_photos` | `kind` | Enum | ✓ | `HERO` \| `GALLERY` |
| `site_photos` | `position` | SmallInt | ✓ | Ordenação manual |
| `site_leads` **(nova)** | `id` / `tenant_id` | UUID | ✓ | PK / RLS |
| `site_leads` | `name` | VarChar(120) | ✓ | — |
| `site_leads` | `phone_encrypted` | Text | ✓ | AES-256-GCM, como todo telefone do sistema |
| `site_leads` | `phone_hash` | String | ✓ | `hashSearchable('lead_phone', …)` — casa com tutor existente (AC-04) |
| `site_leads` | `email_encrypted` | Text | — | Opcional no formulário |
| `site_leads` | `message` | VarChar(1000) | — | Texto puro |
| `site_leads` | `status` | Enum | ✓ | `NEW` \| `CONTACTED` \| `CONVERTED` \| `DISCARDED` |
| `site_leads` | `existing_tutor_id` | UUID | — | Preenchido quando o telefone já é de cliente |
| `site_leads` | `converted_tutor_id` | UUID | — | Resultado da conversão |
| `site_leads` | `ip_address` / `user_agent` | Inet / Text | — | Antiabuso; retenção curta |
| `site_leads` | `purged_at` | Timestamptz | — | Quando o PII foi apagado pela retenção |
| `tenant_settings` | `address_zip`, `address_street`, `address_number`, `address_complement`, `address_district`, `address_city`, `address_state` | VarChar | — | ✅ **Já implementado.** Endereço público do estabelecimento |
| `tenant_settings` | `latitude`, `longitude` | Decimal | — | ✅ **Já implementado**, reservados; sem geocodificação na v1 |
| `tenant_settings` | `public_phone`, `public_whatsapp` | VarChar(20) | — | ✅ **Já implementado.** Distintos do número de disparo do MOD-CRM |
| `tenants` | `custom_domain` | VarChar(253) | — | ✅ **Já implementado**, único global; nulo na v1 |
| `tenants` | `custom_domain_status` | Enum | — | ✅ `PENDING` \| `VERIFYING` \| `ACTIVE` \| `FAILED` |
| `tenants` | `custom_domain_verified_at` | Timestamptz | — | ✅ **Já implementado** |

> ✅ **A parte do tenant já está no código**, desde 2026-08-28: migration
> `20260828160000_tenant_public_profile`, os campos em `TenantSettingsSchema`, o PATCH
> de `/v1/tenants/me/settings` e o cartão "Endereço e contato" em `/configuracoes`.
> Quem implementar o MOD-SITE **não precisa criar nada disso** — só consumir. O CHECK
> `tenant_settings_address_complete` já garante no banco o "tudo ou nada" do endereço.
| `services` | `show_on_site` | Boolean | ✓ | **Novo**, default `true` (AC-04 de MOD-SITE-05) |

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| `phone_encrypted` | `site_leads` | Dado pessoal de **terceiro que ainda não é cliente**. Merece o mesmo tratamento do telefone de tutor — mais, até: não há relação contratual que justifique guardá-lo em claro |
| `email_encrypted` | `site_leads` | Idem |
| — | `tenant_settings` (endereço) | **Não cifrado, de propósito.** É endereço comercial, e o módulo existe para publicá-lo. Cifrar dado destinado à página pública é cerimônia sem proteção — o contraste com `tutor_addresses`, que é residencial e cifrado, é deliberado |

### Índices Necessários

```sql
CREATE INDEX idx_site_leads_tenant_status
  ON site_leads (tenant_id, status, created_at DESC);

-- AC-04 de MOD-SITE-08: o lead que já é cliente.
CREATE INDEX idx_site_leads_phone_hash
  ON site_leads (tenant_id, phone_hash);

-- Varredura do job de retenção.
CREATE INDEX idx_site_leads_retention
  ON site_leads (created_at)
  WHERE purged_at IS NULL;

CREATE INDEX idx_site_photos_tenant_kind
  ON site_photos (tenant_id, kind, position);

-- Resolução por host. Único global: dois tenants não podem reivindicar o mesmo domínio.
CREATE UNIQUE INDEX idx_tenants_custom_domain
  ON tenants (custom_domain)
  WHERE custom_domain IS NOT NULL;
```

> As três tabelas novas entram em `RLS_MODELS` com policy na migration. **`site_leads` tem a mesma ressalva do `portal_link_challenges` do MOD-PORTAL:** a escrita acontece antes de existir contexto de sessão — o tenant vem do host. É consulta de `packages/db/src/platform.ts`, com o `tenant_id` passado explicitamente.

---

## 5. Contratos de API

Duas superfícies distintas, e a separação importa: a **pública** é anônima, cacheável e não conhece usuário; a **administrativa** vive sob o `/v1` de sempre, com `site:manage`.

### Endpoints públicos — `tenant-site-service:3013`, consumidos pelo Next em SSR

| Método | Path | Autenticação | Descrição |
|---|---|---|---|
| GET | `/public/v1/site` | **nenhuma** (tenant pelo host) | Payload completo da página: tenant, branding, endereço, horário, textos, fotos, serviços com faixa de preço, flags de CTA |
| GET | `/public/v1/site/seo` | nenhuma | Metadados, JSON-LD e dados do sitemap |
| POST | `/public/v1/site/leads` | nenhuma + honeypot + rate limit | Envio do formulário |

### Endpoints administrativos — `/v1`, permissão `site:manage`

| Método | Path | Descrição |
|---|---|---|
| GET / PUT | `/v1/site/settings` | Textos, flags, SEO |
| POST | `/v1/site/publish` / `/v1/site/unpublish` | Publicação |
| GET / POST | `/v1/site/photos` | Galeria |
| PATCH / DELETE | `/v1/site/photos/:id` | Ordem, `alt`, remoção |
| GET | `/v1/site/leads` | Fila (filtro por status) |
| PATCH | `/v1/site/leads/:id` | Muda status, anota |
| POST | `/v1/site/leads/:id/convert` | Conversão (exige também `tutor:create`) |
| GET | `/v1/site/preview` | Payload de pré-visualização, inclusive despublicado |

> **`GET /public/v1/site` é uma resposta inteira, e não seis chamadas.** A página é renderizada no servidor a cada revalidação; seis idas ao banco por render multiplicariam por seis o custo de um site que precisa ser rápido no 4G. O payload é montado uma vez e cacheado — é exatamente o caso em que o BFF vale a pena.

### Schema Zod — pacote `packages/shared-types`

```typescript
import { z } from 'zod'

/** Endereço público do estabelecimento — MOD-SITE-02. Sem cifra: é para publicar. */
export const TenantAddressSchema = z.object({
  zip: z.string().regex(/^\d{5}-?\d{3}$/),
  street: z.string().min(3).max(120),
  number: z.string().min(1).max(10),
  complement: z.string().max(60).optional(),
  district: z.string().min(2).max(80),
  city: z.string().min(2).max(80),
  state: z.string().length(2),
})

export const SiteSettingsSchema = z.object({
  headline: z.string().max(120).optional(),
  about: z.string().max(800).optional(),
  notice: z.string().max(200).optional(),
  footerNote: z.string().max(200).optional(),
  showPrices: z.boolean().default(true),
  leadFormEnabled: z.boolean().default(true),
  seoTitle: z.string().max(60).optional(),
  seoDescription: z.string().max(160).optional(),
}).strict()

/** MOD-SITE-08. `website` é o honeypot: precisa chegar vazio (mesmo padrão do Portal). */
export const SiteLeadSchema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().min(10).max(20),
  email: z.email().optional(),
  message: z.string().min(3).max(1000).optional(),
  website: z.string().max(0).optional(),
}).strict()

/** O que o Next recebe para renderizar. Nada aqui é dado de cliente. */
export const PublicSiteResponseSchema = z.object({
  tenant: z.object({ name: z.string(), slug: z.string(), timezone: z.string() }),
  branding: BrandingSchema,
  address: TenantAddressSchema.nullable(),
  contact: z.object({ phone: z.string().nullable(), whatsapp: z.string().nullable() }),
  businessHours: BusinessHoursSchema,
  content: SiteSettingsSchema.partial(),
  photos: z.array(z.object({ url: z.url(), alt: z.string().nullable(), kind: z.enum(['HERO', 'GALLERY']) })),
  services: z.array(z.object({
    name: z.string(),
    description: z.string().nullable(),
    /** MIN(service_pricing.price_cents). Nulo quando o serviço não tem tabela. */
    fromPriceCents: z.number().int().nullable(),
  })),
  cta: z.object({
    bookingUrl: z.url().nullable(),
    taxiHighlighted: z.boolean(),
    leadFormEnabled: z.boolean(),
  }),
})
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| `ERR_SITE_001` | 422 | Publicação sem os dados mínimos (endereço, contato, serviço) |
| `ERR_SITE_002` | 422 | Endereço inválido |
| `ERR_SITE_003` | 422 | Limite da galeria atingido |
| `ERR_SITE_004` | 429 | Rate limit do formulário público |
| `ERR_SITE_005` | 422 | Lead inválido (telefone ou mensagem) |
| `ERR_SITE_006` | 404 | Site não publicado, tenant inativo ou host desconhecido |
| `ERR_SITE_007` | 409 | Domínio próprio já reivindicado por outro tenant |
| `ERR_SITE_008` | 403 | Sem `site:manage` |

---

## 6. Máquinas de Estado

### Site

```
DRAFT  (site_settings.published = false)
  │
  ├─(POST /v1/site/publish, dados mínimos completos)──► PUBLISHED
  │                                                        │
  │                                                        ├─(POST /v1/site/unpublish)──► DRAFT
  │                                                        │
  │                                                        └─(tenant.status ≠ ACTIVE)──► SUSPENSO
  │                                                              (404 sem alterar `published`)
  │
  └─(dados mínimos ausentes)──► DRAFT  [422 ERR_SITE_001]
```

### Lead

```
NEW ──(equipe registra contato)──► CONTACTED ──(POST /convert)──► CONVERTED
 │                                     │
 │                                     └─(sem retorno / descarte)──► DISCARDED
 │                                                                       │
 └─(12 meses em NEW)──► DISCARDED ──(job de retenção, +12 meses)──► PII apagado (purged_at)
```

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notificações | Audit Log |
|---|---|---|---|---|
| DRAFT | PUBLISHED | `site.publicado` | — | ✓ |
| PUBLISHED | DRAFT | `site.despublicado` | — | ✓ |
| — | NEW | `lead.recebido` | Aviso à equipe (e-mail/WhatsApp, `TRANSACTIONAL`) | ✓ |
| CONTACTED | CONVERTED | `lead.convertido` | — | ✓ |
| DISCARDED | purged | — | — | ✓ (só metadado) |

---

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | O site não tem conteúdo próprio duplicado | Horário, serviços, preço, nome e cores vêm da fonte única. Só quatro textos livres são exclusivos do site | MOD-SITE, MOD-IDENT, MOD-AGENDA |
| RN-02 | Endereço do estabelecimento não é cifrado | É comercial e destinado à publicação. O do tutor continua cifrado — são naturezas diferentes | MOD-SITE, MOD-TUTOR, MOD-SEC |
| RN-03 | O site nunca toca em dado de cliente | Nenhuma consulta a `tutors`, `pets`, `appointments` ou `ledger_entries`. A superfície pública não tem caminho até eles nem por engano | MOD-SITE, MOD-SEC |
| RN-04 | Preço público é piso, nunca exato | `MIN(price_cents)` rotulado "a partir de". O valor exato exige saber o pet, e isso é o Portal | MOD-SITE, MOD-AGENDA |
| RN-05 | Vitrine é subconjunto do catálogo | `show_on_site` filtra; `TAXI` nunca entra na lista agendável | MOD-SITE, MOD-AGENDA, MOD-TAXI |
| RN-06 | Site acompanha o estado da conta | Tenant fora de `ACTIVE` responde 404, independentemente de `published` | MOD-SITE, MOD-IDENT |
| RN-07 | Texto do admin é texto puro | Sem editor rico, sem HTML do usuário, sem XSS armazenado a defender | MOD-SITE, MOD-SEC |
| RN-08 | Honeypot responde como sucesso | 201 idêntico. Erro ensinaria o bot | MOD-SITE, MOD-PORTAL, MOD-SEC |
| RN-09 | Lead que já é cliente vem marcado | Casamento por `phone_hash`, visível só para a equipe | MOD-SITE, MOD-TUTOR |
| RN-10 | Ver lead e criar tutor são permissões distintas | `site:manage` vê a fila; `tutor:create` converte | MOD-SITE, MOD-IDENT |
| RN-11 | Lead não convertido tem prazo | 12 meses até `DISCARDED`, mais 12 até apagar o PII. Dado de terceiro sem finalidade é passivo | MOD-SITE, MOD-SEC |
| RN-12 | O selo "aberto agora" é calculado no cliente | Página cacheada com selo do servidor mente na virada do horário | MOD-SITE |
| RN-13 | Cache sobrevive à queda do serviço | Stale-while-revalidate: o site tem SLO 24/7, o petshop não | MOD-SITE, MOD-ADMIN |
| RN-14 | Host decide antes de rota | A resolução pública é por host; o host da aplicação continua com o comportamento atual do middleware | MOD-SITE, MOD-IDENT |
| RN-15 | Subdomínio nunca morre | Mesmo com domínio próprio ativo, o slug responde com 301. Ele está impresso em QR code | MOD-SITE, MOD-PORTAL |
| RN-16 | Certificado só para host autorizado | O TLS sob demanda consulta a lista de domínios `ACTIVE`; sem isso, apontar um domínio para o IP faria a borda emitir certificado para qualquer um | MOD-SITE, implantação |

---

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange `petshop.events` (topic), DLX com backoff 1s / 5s / 30s / 5min.

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `site.publicado` | tenant-site-service | frontend (revalidar), audit, MOD-ADMIN | `{ tenantId, slug, occurredAt }` |
| `site.despublicado` | tenant-site-service | frontend (invalidar), audit | `{ tenantId, slug, occurredAt }` |
| `lead.recebido` | tenant-site-service | crm-automation (avisa a equipe), audit | `{ tenantId, leadId, isExistingCustomer, occurredAt }` |
| `lead.convertido` | tenant-site-service | crm-automation (boas-vindas), audit | `{ tenantId, leadId, tutorId, occurredAt }` |

**Consumidos para revalidação (MOD-SITE-11 AC-03):** `tenant.configuracao.atualizada` (existe hoje) e `servico.criado` / `servico.atualizado` / `servico.removido` — **que ainda não existem** e precisam nascer no scheduling-service. Cada um invalida o host daquele tenant, e só ele — revalidar todos os sites porque um petshop mudou o horário desperdiça render de todo mundo.

---

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | Super Admin | Admin do Tenant | Recepção | Profissional | Visitante anônimo |
|---|---|---|---|---|---|
| Ver o site publicado | ✓ | ✓ | ✓ | ✓ | **✓** |
| Enviar formulário de contato | ✓ | ✓ | ✓ | ✓ | **✓** |
| Editar conteúdo do site | ✓ | ✓ (`site:manage`) | — | — | — |
| Publicar / despublicar | ✓ | ✓ (`site:manage`) | — | — | — |
| Ver a fila de leads | ✓ | ✓ | ✓ (`site:manage`) | — | — |
| Converter lead em tutor | ✓ | ✓ | ✓ (`tutor:create`) | — | — |
| Configurar domínio próprio | ✓ | ✓ | — | — | — |

> **Nenhuma permissão nova.** `site:manage` já existe no catálogo desde o MOD-IDENT-04 e nunca foi usada — este módulo é o primeiro a exigi-la. O total permanece em **54** (as 53 originais mais `crm:read_own`, do MOD-PORTAL).

### Audit Log — ações que DEVEM gerar registro imutável

- **Publicação e despublicação** → quem, quando, e o estado anterior
- **Alteração de endereço público ou telefone** → é o dado que o cliente usa para chegar; mudança errada some com o movimento
- **Conversão de lead** → `leadId` → `tutorId`, e quem converteu
- **Descarte de lead** e **execução da retenção** (quantas linhas, quando)
- **Configuração de domínio próprio** e cada transição do estado de verificação

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| `site_leads.name`, `phone_encrypted`, `email_encrypted` | Dado pessoal de terceiro | Legítimo interesse (contato solicitado pelo próprio titular) | 12 meses até `DISCARDED`; PII apagado em +12 | ✓ (se virar tutor) | ✓ |
| `site_leads.message` | Dado pessoal (conteúdo livre) | Idem | Idem | ✓ | ✓ |
| `site_leads.ip_address`, `user_agent` | Dado pessoal | Legítimo interesse (antiabuso) | 90 dias | — | ✓ |
| `tenant_settings` endereço e telefones | **Dado da empresa**, não pessoal | Execução de contrato | Enquanto durar a conta | ✓ | ✓ |

**O ponto de atenção do módulo em LGPD é o lead.** Todo o resto do sistema trata dados de quem tem relação com o petshop — cliente, pet, funcionário. O lead é a primeira categoria de **pessoa sem vínculo nenhum**, que preencheu um formulário e talvez nunca mais apareça. O formulário informa, no envio, para que o dado será usado e por quanto tempo fica; e a retenção do RN-11 é o que impede o sistema de virar depósito de telefone de gente que só perguntou o preço do banho.

---

## 10. Performance & Observabilidade

### Cache Redis (no `tenant-site-service`)

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Payload público completo | 600s | `site:public:{tenantId}` | `site.publicado`, `tenant.configuracao.atualizada`, `servico.*` (quando existir) |
| Resolução host → tenant | 3600s | `site:host:{host}` | `site.publicado`, mudança de domínio |
| Host desconhecido (negativo) | 300s | `site:host:miss:{host}` | — |
| Rate limit do formulário | 900s | `site:rl:{ip}` | Janela |

> O **cache negativo** não é detalhe: sem ele, um bot varrendo subdomínios inexistentes vira uma consulta ao banco por requisição. Com ele, vira uma a cada cinco minutos por host.

### Métricas de Negócio (Pino structured log)

```json
{ "metric": "site_lead_received", "tenantId": "...", "value": 1, "unit": "count" }
```

- `site_page_view`: por tenant, contínuo — o número que diz ao petshop se o site serve para alguma coisa
- `site_lead_received` e `site_lead_converted`: a taxa entre os dois é o valor real do módulo
- `site_cta_booking_click`: cliques em "Agendar" — liga o MOD-SITE ao KPI de self-service do MOD-PORTAL
- `site_render_duration_ms`: p95 do render no servidor
- `site_revalidation_lag_ms`: do evento à página atualizada. É o número que prova o AC-02 do MOD-SITE-06

### SLOs

| Superfície | Alvo |
|---|---|
| Página pública (cache quente) | p95 < 300 ms, LCP < 2,5 s no 4G |
| `GET /public/v1/site` (cache frio) | p95 < 600 ms |
| Revalidação após evento | < 30 s |
| Disponibilidade do site | 99,9% — é a superfície mais exposta e a que o buscador visita sem avisar |

### Jobs

| Job | Cadência | O que faz |
|---|---|---|
| `site-leads-retention` | diário | Move `NEW` com 12 meses para `DISCARDED`; apaga o PII dos descartados com mais de 12 meses |
| `site-health-check` | 15 min | Verifica que cada site publicado responde 200; falha vira alerta do MOD-ADMIN |
| `custom-domain-verify` | 10 min | *(MOD-SITE-12, quando entrar)* Confere os registros DNS dos domínios `PENDING` |

---

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | **O site entra no plano Starter?** O PRD-mãe §88 lista "site próprio" como diferencial de plano. Se for de plano superior, `site:manage` precisa de um gate por `tenants.plan`, e isso é mecanismo que ainda não existe em lugar nenhum do sistema | MOD-SITE, MOD-IDENT, PRD comercial | Dono do produto | Antes da fatia 1 |
| 2 | **Quem recebe o aviso de lead novo?** Todos com `site:manage`, um e-mail fixo de configuração, ou o WhatsApp do estabelecimento? Cada opção muda o que o MOD-CRM precisa saber sobre destinatário interno — hoje ele só sabe mandar para tutor | MOD-SITE, MOD-CRM | Dono do produto | Durante a fatia 3 |
| 3 | **Analytics de terceiro.** O petshop vai querer Google Analytics ou Meta Pixel na página dele. Permitir é abrir script de terceiro numa superfície pública (CSP, consentimento de cookie, LGPD); não permitir é frustrar quem faz tráfego pago | MOD-SITE, MOD-SEC | Dono do produto + Tech Lead | Pós-piloto |
| 4 | **Banner de cookie.** Sem analytics de terceiro, o site não usa cookie não essencial e não precisa de banner. A resposta depende inteiramente da questão 3 | MOD-SITE, MOD-SEC | Jurídico | Junto com a 3 |
| 5 | **Foto de pet de cliente na galeria.** O AC-03 de MOD-SITE-04 exige upload deliberado e avisa sobre autorização — mas o sistema não *guarda* essa autorização. Vira um `purpose` novo em `tutor_consents` (`publicidade`), ou fica como responsabilidade do petshop, fora do sistema? | MOD-SITE, MOD-TUTOR, MOD-SEC | Jurídico + Dono do produto | Antes da fatia 2 |
| 6 | **Quando o domínio próprio entra?** A v1 modela e não implementa. Vale saber se é Fase 6, se é gatilho comercial (plano Pro), ou se é quando o primeiro cliente pedir | MOD-SITE, implantação | Dono do produto | Pós-piloto |

---

## Apêndice — Fatiamento sugerido da implementação

| Fatia | Conteúdo | Por que nesta ordem |
|---|---|---|
| **1** | MOD-SITE-02 (endereço e contato) + MOD-SITE-11 (roteamento por host e ISR) | O endereço é dado que falta ao produto inteiro, não só ao site — e o roteamento por host é a mudança de risco no `middleware.ts`. As duas primeiro, com teste, antes de haver página a expor |
| **2** | MOD-SITE-01, 03, 05, 06, 07 | A página em si: publicação, textos, vitrine, horário e as chamadas para ação. Ao fim da fatia 2 o site existe e serve |
| **3** | MOD-SITE-08, 09 + MOD-SITE-04 | Captação, fila de leads e galeria. Nada aqui bloqueia o anterior, e a conversão de lead depende do MOD-TUTOR, que está pronto |
| **4** | MOD-SITE-10 | SEO. Deliberadamente por último: metadado de página que ainda muda de forma é metadado a refazer. Antes disso, `noindex` em tudo |

> **Dependência com a implantação:** nenhum container novo. O Caddy já entrega `*.{$APP_DOMAIN}` ao `frontend:3002`, e o site é rota do frontend (SPEC §33). O que muda na borda é só o dia em que o MOD-SITE-12 entrar — aí sim, `on_demand_tls` com endpoint de autorização.
