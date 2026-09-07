# PRD Detalhado — Documentos (Geração de PDF)

**Módulo:** MOD-DOC
**Arquivo:** 11/15
**Prioridade:** P1
**Fase de Implementação:** Fase 6 — Documentos e Notificações
**Serviço Backend:** nenhum serviço novo — `packages/pdf` (mecanismo do Gotenberg, já no compose na porta 3030) e `packages/documents` (registro, numeração, molde e armazenamento). A emissão fica distribuída entre `medical-record-service` (3005), `billing-ledger-service` (3007), `tutor-service` (3003) e `portal-bff` (3020)
**Tabelas Principais:** `documents`, `document_counters`, `prescriptions`, `term_versions` (novas); `receipts`, `professionals`, `tutor_consents` (alteradas)
**Data:** 2026-09-07
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** O petshop brasileiro funciona no papel em três momentos, e só três: quando o tutor deixa o pet e assina que sabe dos riscos, quando o veterinário prescreve, e quando alguém paga. O PRD-mãe §7.10 chama isso de "módulo de documentos" e lista recibos, comprovantes, receituários e termos. Destes, o sistema hoje emite **um**: o recibo de pagamento, mais os dois relatórios de cobrança. Os outros não faltam por falta de impressora — faltam porque o sistema nunca teve onde registrar que um documento foi emitido, para quem, em que versão e com que número.

**A descoberta que dá substância ao módulo.** `CURRENT_TERMS_VERSION = '1.0'` está cravado em `packages/shared-types/src/tutor.ts` desde o MOD-TUTOR, e toda linha de `tutor_consents` grava essa versão como prova. Ou seja: **o sistema registra, com IP, user-agent e carimbo de tempo, o aceite de um documento que não existe em lugar nenhum.** Não há texto, não há PDF, não há como o tutor reler o que aceitou nem como o petshop provar o que apresentou. A mesma ausência aparece do outro lado: `ERR_PRONT_009` ("Prescrição exige CRMV") está no catálogo de erros desde o MOD-PRONT e **nenhuma rota consegue levantá-lo**, porque `professionals` não tem campo de CRMV e `prescriptions` não é tabela. O MOD-DOC fecha as duas pontas — dá corpo ao que já se registrava e destrava o que já se previa.

**Integração sistêmica.** Upstream: **MOD-IDENT** (nome, logo, cores e o endereço público que o MOD-SITE acrescentou — é o cabeçalho de todo documento), **MOD-PRONT** (o atendimento de onde nasce a prescrição), **MOD-LEDGER** (recibo e extrato), **MOD-TUTOR** (`tutor_consents` é a prova jurídica do aceite, e continua sendo). Downstream: **MOD-NOTIF** (o par desta fase — é quem anexa o documento ao e-mail), **MOD-PORTAL** (o tutor baixa o que é dele), **MOD-CRM** (o WhatsApp manda o link, nunca o arquivo), **MOD-ADMIN** (toda emissão é evento auditável), **MOD-AI** (o agente responde "me manda o recibo de março").

**Escopo da v1.** Entram as doze sub-features do §2, com a décima segunda **especificada e não construída**. Ficam de fora, por decisão registrada: **comprovante de agendamento** (o balcão entrega a informação pela agenda e pelo WhatsApp; um papel a mais para o mesmo dado não paga o custo), **emissão de NFS-e** (obrigação municipal do tenant, e RN-20 do MOD-LEDGER manda o recibo dizer isso em letra impressa), **assinatura ICP-Brasil** (questão 2 do §11 do MOD-PRONT, pós-MVP), **anexos digitalizados** (é o MOD-PRONT-06, que continua fora), e **editor de template pelo tenant** — pelo mesmo motivo que o MOD-SITE recusou o editor de blocos: um documento formal montado por quem não é designer sai pior que o modelo fixo, e aqui sai também com risco jurídico.

---

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-DOC-01 | Motor de documento | O modelo base: cabeçalho do tenant, rodapé, CSS único e paginação | Must Have |
| MOD-DOC-02 | Registro e arquivamento | Tabela `documents`, objeto no R2, checksum e retenção; o recibo passa a apontar para ela | Must Have |
| MOD-DOC-03 | Numeração | Série sequencial por tenant, ano e tipo; generaliza o `receipt_counters` do MOD-LEDGER | Must Have |
| MOD-DOC-04 | Receituário veterinário | `prescriptions`, itens estruturados, CRMV em snapshot, PDF imutável (fecha MOD-PRONT-07) | Must Have |
| MOD-DOC-05 | CRMV do profissional | Campo novo em `professionals`; é o que torna a RN-10 do MOD-PRONT aplicável | Must Have |
| MOD-DOC-06 | Termos versionados | Texto do termo por tenant e versão; aposenta o `CURRENT_TERMS_VERSION` cravado no código | Must Have |
| MOD-DOC-07 | Termo de responsabilidade | Aceite eletrônico registrado e o PDF do que foi aceito | Must Have |
| MOD-DOC-08 | Autorização de uso de imagem | Mesmo mecanismo, sobre o canal `IMAGE_USE` que já existe em `tutor_consents` | Should Have |
| MOD-DOC-09 | Extrato em PDF | O `statement.pdf` que o MOD-LEDGER prometeu, no Admin e no Portal | Should Have |
| MOD-DOC-10 | Entrega ao tutor | Download no Portal e a lista "Meus documentos"; anexo por e-mail fica com o MOD-NOTIF | Should Have |
| MOD-DOC-11 | Reprocesso e degradação | Job de reemissão, `isConfigured` na tela e o que acontece quando o Gotenberg cai | Must Have |
| MOD-DOC-12 | Verificação de autenticidade | Código no rodapé e rota pública de conferência; **não implementado na v1** | Nice to Have |

---

## 3. Critérios de Aceite

### [MOD-DOC-01] — Motor de Documento

> **Decisão de arquitetura (2026-09-07): pacote com registro comum, não `document-service:3012`.** O SPEC §57 desenha um serviço dedicado. Ele não nasce, pelo mesmo motivo que a porta 3011 do MOD-NOTIF não nasceu: um serviço central de documentos obriga cada serviço de domínio a mandar, por HTTP, o payload clínico e financeiro que ele já tem em mãos, para receber de volta um arquivo. O que é comum entre documentos — falar com o Gotenberg, degradar quando ele não responde, o cabeçalho do tenant, o registro do que foi emitido — cabe num pacote e numa tabela. O que não é comum — saber o que é uma prescrição — continua no serviço que sabe. O `packages/pdf` já dizia isso no próprio cabeçalho desde o MOD-LEDGER; esta decisão é a confirmação dele, não uma novidade.

> **Como ficou, na implementação da fatia 1:** são **dois** pacotes, e não um. O `@petshop/pdf` continua sendo "HTML vira PDF, e nada mais" — sem dependência de banco, como nasceu. O `@petshop/documents` é o novo, e guarda o registro, a numeração, o molde de página e o armazenamento; depende dos dois. Concentrar tudo em `@petshop/pdf` obrigaria o pacote mais simples do repositório a passar a depender do Prisma e do SDK da S3.

**AC-01 (Happy Path — cabeçalho e rodapé comuns)**
- **Dado** um tenant com nome, logo, endereço público e telefone preenchidos
- **Quando** qualquer documento do sistema é renderizado
- **Então** o PDF sai com o cabeçalho padrão (logo à esquerda, razão social, endereço completo, telefone e CNPJ quando houver) e o rodapé padrão (identificação do documento, paginação `n/N` e a data de emissão no fuso do tenant); **200**

**AC-02 (Validação / Erro — tenant sem endereço)**
- **Dado** um tenant que nunca preencheu o endereço público (possível: o campo nasceu em 2026-08-28 e tenants anteriores estão sem ele)
- **Quando** um documento com valor legal é emitido
- **Então** **422** `ERR_DOC_002` dizendo qual dado falta. Documento formal sem o endereço de quem emitiu não é documento; é papel timbrado pela metade

**AC-03 (Edge Case — campo livre com HTML)**
- **Dado** um tutor cadastrado como `<script>alert(1)</script>` ou uma observação clínica com `<` e `&`
- **Quando** o documento é renderizado
- **Então** o texto aparece literal no PDF e nada executa. O Gotenberg roda um Chromium de verdade; `escapeHtml` do `packages/pdf` é obrigatório em **todo** campo livre, e o teste do pacote cobre isso por tipo de documento, não uma vez só

**AC-04 (Edge Case — HTML que não converge)**
- **Dado** um documento cujo HTML leva mais de 30 segundos para renderizar
- **Quando** o Gotenberg estoura o `timeoutMs`
- **Então** a requisição é abortada, `PdfUnavailableError` sobe, o documento fica `FAILED` com a causa em `last_error` e **nenhuma** conexão fica pendurada

---

### [MOD-DOC-02] — Registro e Arquivamento

> **Decisão de produto (2026-09-07): arquiva-se o que tem valor legal; o resto se regenera.** Recibo, receituário e termo aceito vão ao R2 e são imutáveis, porque precisam bater, byte a byte, com o papel que a pessoa levou naquele dia. Extrato e relatório são **regerados a cada pedido**, porque descrevem o estado atual e não uma promessa — um extrato guardado é um extrato errado uma semana depois. A regra de entrega segue a mesma divisão e vira norma do sistema: **documento arquivado desce por URL assinada de TTL curto; documento regerado desce em bytes na resposta.** Os dois padrões já existiam soltos no código (o recibo assina, os relatórios de cobrança descem em bytes); aqui eles ganham motivo.

**AC-01 (Happy Path — emissão registra)**
- **Dado** um documento arquivável recém-renderizado
- **Quando** a emissão conclui
- **Então** o objeto vai ao R2 sob a chave `tenants/{tenantId}/documents/{documentId}.pdf`, grava-se em `documents` o tipo, o número, o `storage_key`, o `checksum` SHA-256, o tamanho em bytes, `issued_at`, `retention_until` e o sujeito (tutor e/ou pet), publica-se `documento.emitido` e o status vai a `ISSUED`

**AC-02 (Happy Path — download)**
- **Dado** um documento `ISSUED` e um usuário com permissão sobre ele
- **Quando** pede o arquivo
- **Então** recebe **302** para uma URL assinada com TTL de 15 minutos — o mesmo que o recibo já usava desde o MOD-LEDGER —, e o acesso entra na trilha de auditoria com quem pediu e de onde

**AC-03 (Cenário negativo — documento de outro tenant ou de outro tutor)**
- **Dado** um identificador de documento que não pertence ao tenant do contexto, ou que pertence ao tenant mas não ao tutor autenticado no Portal
- **Quando** o download é pedido
- **Então** **404** `ERR_DOC_001`, nunca 403. É a mesma regra que o MOD-PORTAL fixou para todo `_own`: 403 confirma existência, e existência de documento clínico alheio já é vazamento

**AC-04 (Edge Case — o recibo que já existia)**
- **Dado** o parque de recibos emitidos desde o MOD-LEDGER, com `storage_key` na própria tabela `receipts`
- **Quando** a migration do módulo roda
- **Então** cada recibo ganha uma linha em `documents` com o mesmo arquivo, o mesmo número e o mesmo `issued_at`, e `receipts.document_id` passa a apontar para ela. O `receipts.storage_key` **não é removido nesta migration** — para de ser escrito e vira leitura de reserva, e cai numa segunda migration depois de uma janela de convivência. Derrubar a coluna e o backfill no mesmo passo tira o caminho de volta

**AC-05 (Edge Case — reemissão nunca sobrescreve)**
- **Dado** um documento `ISSUED`
- **Quando** algo pede a emissão de novo (job, clique duplo, retry de fila)
- **Então** devolve-se o que existe, sem gerar arquivo novo e sem consumir número. Documento arquivado é imutável (`ERR_DOC_004` se alguém tentar forçar), e a única transição possível a partir de `ISSUED` é `CANCELLED`

---

### [MOD-DOC-03] — Numeração

**AC-01 (Happy Path)**
- **Dado** dois documentos do mesmo tipo emitidos no mesmo tenant e no mesmo ano
- **Quando** ambos recebem número
- **Então** a série é `{tipo}-{ano}/{sequencial de 6 dígitos}` — por exemplo `REC-2026/000123`, `RX-2026/000004` — contínua e sem buracos previsíveis

**AC-02 (Edge Case — concorrência no balcão)**
- **Dado** dois atendentes emitindo o mesmo tipo de documento no mesmo segundo
- **Quando** os dois pedem número
- **Então** recebem números diferentes, garantido por `INSERT … ON CONFLICT DO UPDATE … RETURNING` numa instrução só sobre `document_counters` — o mesmo mecanismo que o `allocateNumber` do MOD-LEDGER já usa, generalizado. **Não** se cria `SEQUENCE`: sequence é global e uma por tenant exigiria DDL em tempo de execução

**AC-03 (Edge Case — documento cancelado)**
- **Dado** um documento cancelado
- **Quando** o próximo do mesmo tipo é emitido
- **Então** o número do cancelado **não** volta para a fila. Um buraco na sequência é uma pergunta que o contador sabe responder; um número reaproveitado é um documento duplicado que ele não sabe. É a RN-21 do MOD-LEDGER, promovida a regra do módulo

**AC-04 (Edge Case — série do recibo preservada)**
- **Dado** que os recibos já emitidos usam o formato `2026/000123`, sem prefixo de tipo
- **Quando** a numeração generalizada entra
- **Então** a série do recibo **continua como está** e o contador dele continua em `receipt_counters`, migrado para `document_counters` com o tipo `RECEIPT` e o `last_number` corrente. Renumerar recibo emitido é reescrever documento entregue

---

### [MOD-DOC-04] — Receituário Veterinário

> Fecha o **MOD-PRONT-07**, que ficou de fora do prontuário justamente por depender deste módulo. O receituário é o documento mais delicado do sistema: erra a dosagem e mata o animal, sai sem CRMV e expõe o profissional, muda depois de emitido e deixa de ser prova.

> **Como ficou, na implementação da fatia 2 (2026-09-08):** três decisões que o PRD não previa e o código precisou tomar.
>
> **Quem assina é quem está logado**, e não o `performed_by` do atendimento. O prescritor é o profissional cujo `professionals.user_id` é o usuário autenticado; sem esse vínculo, `403 ERR_PRONT_009`. São a mesma pessoa no caminho normal, e a diferença importa justamente quando não são — um receituário emitido pelo balcão em nome do veterinário que não está na sala é prova falsa, e `record:write` sozinho não distingue os dois.
>
> **`/v1/prescriptions/:id/pdf` com 302 não nasce.** O gateway encaminha com `fetch` e `redirect: 'follow'`: o 302 seria consumido lá dentro e os bytes do arquivo voltariam pela rede interna — exatamente o que a URL assinada existe para evitar. O endereço desce no corpo do `GET /v1/prescriptions/:id`, como o recibo já fazia desde o MOD-LEDGER, e é **essa** chamada que a trilha do §9 registra como download. A listagem não assina nada: abrir a aba do pet não é baixar o receituário dele.
>
> **Não há PATCH.** A ausência da rota é a regra do AC-04; o 409 `ERR_PRONT_006` que resta é o da segunda anulação.

**AC-01 (Happy Path)**
- **Dado** um atendimento do tipo veterinário, conduzido por um profissional com CRMV cadastrado
- **Quando** o veterinário emite a prescrição com um ou mais itens (`{ drug, concentration, dosage, frequency, durationDays }`) e orientações ao tutor
- **Então** cria-se `prescriptions` com o CRMV **em snapshot**, gera-se o PDF, arquiva-se, publica-se `prescricao.emitida` e retorna **201** com o número e o identificador do documento

**AC-02 (Cenário negativo — sem CRMV)**
- **Dado** um profissional sem CRMV em `professionals.crmv` — um banhista, ou um veterinário cujo registro ninguém cadastrou
- **Quando** tenta emitir
- **Então** **403** `ERR_PRONT_009` "Prescrição exige CRMV". É a RN-10 do MOD-PRONT, que existe no catálogo de erros desde então e nunca teve como ser levantada

**AC-03 (Cenário negativo — itens inválidos)**
- **Dado** um item sem princípio ativo, sem posologia, ou com `durationDays` menor que 1
- **Quando** submete
- **Então** **422** `ERR_PRONT_002` apontando o índice do item e o campo. Prescrição incompleta não é rascunho — é risco, e não se grava

**AC-04 (Edge Case — imutabilidade)**
- **Dado** uma prescrição emitida
- **Quando** alguém tenta editá-la, mesmo dentro das 24h que o MOD-PRONT concede ao atendimento
- **Então** **409** `ERR_PRONT_006`. A janela de 24h vale para o registro clínico, **não** para o documento que saiu pela porta. O caminho é anular e emitir outra, e a anulada continua visível na linha do tempo com o motivo

**AC-05 (Edge Case — alerta médico do pet no rodapé)**
- **Dado** um pet com alergia de severidade `CRITICAL` registrada no MOD-PRONT-03
- **Quando** a prescrição é emitida
- **Então** a alergia aparece em destaque no documento, sempre. O papel vai para a mão de quem administra o medicamento em casa, e essa pessoa não abre o sistema

---

### [MOD-DOC-05] — CRMV do Profissional

**AC-01 (Happy Path)**
- **Dado** um tenant com um veterinário na equipe
- **Quando** o admin abre `/agenda/profissionais` e preenche o CRMV (número e UF)
- **Então** o campo grava, o profissional passa a poder prescrever e a mudança entra na trilha de auditoria

**AC-02 (Validação / Erro — formato)**
- **Dado** um CRMV fora do formato `{número}/{UF}` com UF válida
- **Quando** submete
- **Então** **422** `ERR_IDENT_002`. A validação é de forma, não de existência: não há base pública consultável do CFMV, e prometer verificação que não se faz é pior que não prometer

> **Divergência consciente da fatia 2:** o código emitido é `ERR_AGENDA_002`, e não `ERR_IDENT_002`. O campo é do profissional, o profissional é da agenda, e o `scheduling-service` responde pelo próprio catálogo de erro — um serviço que emitisse o código de outro obrigaria quem lê o log a saber de cor qual módulo emprestou qual prefixo. Os dois são 422 e a mensagem é a mesma.
>
> São **duas** colunas (`crmv` e `crmv_state`) e **um** campo impresso (`12345/SP`): número sem UF não identifica ninguém, e é o par que o servidor exige — a checagem é sobre o resultado, não sobre o corpo do PATCH, para que mandar só a UF sobre um cadastro que já tem o número continue valendo.

**AC-03 (Edge Case — CRMV alterado depois de prescrições emitidas)**
- **Dado** um profissional que corrigiu o próprio CRMV
- **Quando** a alteração é salva
- **Então** as prescrições já emitidas **continuam com o número antigo**, porque `prescriptions.crmv` é snapshot. O documento registra o que era verdade no dia; corrigir o passado é falsificá-lo

---

### [MOD-DOC-06] — Termos Versionados

> **Decisão de produto (2026-09-07): o texto do termo passa a ser dado, não constante.** Hoje `CURRENT_TERMS_VERSION = '1.0'` mora em `packages/shared-types` com um `TODO(MOD-SEC)` pedindo exatamente isto. Subir a constante joga todo mundo em `PENDING_RENEWAL` (AC-04 do MOD-TUTOR-04) — comportamento correto que continua valendo, com uma diferença: agora há um texto por trás da versão.

> **Como ficou, na implementação da fatia 3:** **não existe rascunho nem edição**, e por
> isso o AC-04 toma a forma de uma recusa de INSERT: republicar um número que já existe
> devolve 409 `ERR_DOC_004`, com a orientação de subir a versão. Uma rota de PATCH que
> recusasse sempre seria uma porta construída para ficar trancada.
>
> A **vigência** é a data de publicação mais recente, e não uma coluna `current` — uma
> coluna diria "vigente" em duas linhas no dia em que alguém esquecesse de desmarcar a
> anterior. E a validação de versão passou a valer para **toda** escrita em
> `tutor_consents`, inclusive a do cadastro: era por lá que o defeito entraria de volta.

**AC-01 (Happy Path — publicar versão)**
- **Dado** um tenant que quer usar o próprio termo de responsabilidade
- **Quando** o admin publica o texto em Configurações → Documentos
- **Então** cria-se `term_versions` com `kind`, `version`, o corpo em Markdown restrito, `published_at` e quem publicou; a versão anterior continua existindo e legível

**AC-02 (Happy Path — padrão da plataforma)**
- **Dado** um tenant que nunca publicou termo nenhum
- **Quando** um aceite é registrado
- **Então** vale o texto padrão da plataforma, semeado no provisionamento na versão `1.0` — a mesma que todos os consentimentos já gravados referenciam. **O parque existente fica válido retroativamente**, e é para isso que o padrão nasce com esse número

**AC-03 (Cenário negativo — versão não publicada)**
- **Dado** um aceite que chega referenciando uma versão sem linha em `term_versions`
- **Quando** o registro é tentado
- **Então** **422** `ERR_DOC_007`. Prova de aceite sem documento aceito é o defeito que este módulo veio corrigir; não se recria ele por outro caminho

**AC-04 (Edge Case — versão publicada é imutável)**
- **Dado** uma versão de termo já publicada, com aceites registrados
- **Quando** o admin tenta editar o texto
- **Então** **409** `ERR_DOC_004`, com a orientação de publicar uma versão nova. Editar o texto que alguém aceitou é falsificar o contrato de todo mundo que aceitou

---

### [MOD-DOC-07] — Termo de Responsabilidade

> **Decisão de produto (2026-09-07): aceite eletrônico registrado.** Não há assinatura desenhada em tela nem digitalização de papel. A prova é a que `tutor_consents` já guarda desde o MOD-TUTOR: versão do termo, IP, user-agent, origem e carimbo de tempo, numa tabela **append-only por grant** — nem `app_user` nem `app_maintenance` têm UPDATE ou DELETE nela. Isso vale mais, juridicamente, que um rabisco num tablet, funciona igual no balcão e no Portal, e não exige comprar hardware para cada recepção. O canal `SERVICE_LIABILITY` entra no enum `ConsentChannel`, ao lado de `TERMS` e `IMAGE_USE`, que já esticavam a palavra "canal" pelo mesmo motivo.

> **Como ficou, na implementação da fatia 3:** três decisões que o PRD não previa.
>
> 1. **O aceite é do tutor, e o papel nomeia os animais dele no dia.** `tutor_consents` é
>    append-only e não tem coluna de pet; pendurar o aceite no animal exigiria uma tabela
>    nova para dizer o que a prova já diz. O texto fala em "o animal identificado nesta
>    folha", então a folha lista os pets vinculados no momento do aceite — um pet que
>    chega depois entra na folha seguinte.
> 2. **O visto do cadastro grava a prova sem emitir papel.** Emitir documento durante a
>    criação do tutor exigiria o endereço completo do estabelecimento e derrubaria o
>    cadastro de quem ainda não o preencheu (AC-02 de MOD-DOC-01). Quando a prova já
>    existe e o papel não, a rota de aceite emite só o papel e devolve **200** em vez de
>    201 — o 409 do AC-03 vale para quem já tem os dois.
> 3. **O aceite pelo Portal (AC-02) fica com a fatia seguinte**, junto do MOD-DOC-10: o
>    serviço já aceita `source = PORTAL` e a porta do BFF já repassa IP e user-agent, mas
>    a tela do cliente entra com "Meus documentos".

**AC-01 (Happy Path — no balcão)**
- **Dado** um tutor no check-in de um serviço que exige termo
- **Quando** a recepção apresenta o texto vigente na tela e o tutor confirma
- **Então** grava-se `tutor_consents` com `channel = SERVICE_LIABILITY`, `granted = true`, a versão vigente, `source = STAFF_FORM`, o IP e o user-agent **do navegador do tutor quando houver, e o do balcão quando não**; emite-se o PDF do aceite, arquiva-se e retorna **201**

**AC-02 (Happy Path — no Portal)**
- **Dado** o mesmo tutor agendando pelo Portal
- **Quando** confirma o agendamento com o termo apresentado
- **Então** o mesmo registro, com `source = PORTAL`. O `tutor-port.ts` do `portal-bff` já é a porta que assina escrita no tutor-service e já repassa `x-forwarded-for` e `user-agent` — precisamente porque os dois são prova, e sem eles a linha registraria o IP do contêiner do BFF

**AC-03 (Cenário negativo — aceite repetido na mesma versão)**
- **Dado** um tutor que já aceitou a versão vigente
- **Quando** o aceite é enviado de novo
- **Então** **409** `ERR_DOC_006` e nada é gravado. Duplicar linha em tabela append-only é sujar prova

**AC-04 (Edge Case — termo novo com aceite antigo)**
- **Dado** um tutor com aceite na versão `1.0` e o tenant publicou a `2.0`
- **Quando** o tutor aparece para um atendimento
- **Então** o estado do consentimento é `PENDING_RENEWAL` (mecânica que já existe em `mapper.ts` do tutor-service), a tela pede o novo aceite, e **o atendimento não é bloqueado por isso** — recusar serviço por causa de versão de termo é criar um problema de balcão para resolver um problema de arquivo

**AC-05 (Edge Case — revogação)**
- **Dado** um tutor que revoga o aceite
- **Quando** a revogação é registrada
- **Então** entra uma linha nova com `granted = false` e o PDF do aceite original **continua arquivado**. Revogar é fato novo, não apagamento do fato anterior; o documento prova o que valia enquanto valia

---

### [MOD-DOC-08] — Autorização de Uso de Imagem

**AC-01 (Happy Path)**
- **Dado** um tutor que autoriza o uso da imagem do pet
- **Quando** confirma na ficha ou no Portal
- **Então** grava-se em `tutor_consents` no canal `IMAGE_USE`, que **já existe** desde o MOD-TUTOR, e emite-se o PDF da autorização com o escopo declarado: redes sociais do petshop, site do estabelecimento e material impresso

**AC-02 (Cenário negativo — o gate que já existe)**
- **Dado** um pet cujo tutor não autorizou
- **Quando** alguém tenta publicar a foto dele no site ou usá-la em campanha
- **Então** **403** `ERR_PET_010`, comportamento já implementado no `pet-service` (RN-14 / AC-05 do MOD-PET-04). O que este módulo acrescenta não é o bloqueio — é o papel que explica ao tutor o que ele está autorizando

**AC-03 (Edge Case — pet com dois tutores)**
- **Dado** um pet com titular e um segundo tutor vinculado
- **Quando** a autorização é colhida
- **Então** vale a do **titular** (`PetTutor.role = 'PRIMARY'` com `unlinked_at IS NULL`), e o documento nomeia quem autorizou. Autorização de imagem é do responsável, e o vínculo desfeito que ficou na tabela não autoriza nada

---

### [MOD-DOC-09] — Extrato em PDF

> **Como ficou, na implementação da fatia 4:** a folha usa o **molde comum** de
> `@petshop/documents`, como o recibo, e não o molde denso dos relatórios do
> MOD-COBRANCA: ela vai para a mão do tutor, e o cabeçalho de quem emitiu é o que lhe dá
> valor de comprovante de conta. Foi o primeiro documento **sem número de série** — o
> campo virou opcional no molde, porque prometer uma série a um papel que ninguém arquiva
> seria prometer um arquivo que não existe.
>
> Duas diferenças em relação ao recibo, e as duas seguem do AC-04: o extrato **desce em
> bytes** nas duas superfícies (não há objeto no bucket cujo endereço se pudesse assinar)
> e **endereço incompleto não impede a emissão** — recusar a quem quer conferir a própria
> conta porque o petshop não preencheu o CEP seria punir o tutor por um cadastro que não é
> dele. O teto é de 500 lançamentos por folha, e a própria folha diz quantos ficaram de
> fora.

**AC-01 (Happy Path — Admin)**
- **Dado** um tutor com movimento no período
- **Quando** o atendente pede o extrato em PDF de um intervalo
- **Então** recebe os bytes na resposta, com `Content-Disposition: attachment`, contendo saldo de abertura, lançamentos, pagamentos, alocações e saldo de fechamento; **200**

**AC-02 (Happy Path — Portal)**
- **Dado** o mesmo tutor autenticado no Portal
- **Quando** pede o próprio extrato
- **Então** o mesmo documento, sob `finance:read_own`, com o filtro de titularidade injetado pelo `ownScope` do `service-kit` — nunca por checagem no handler

**AC-03 (Edge Case — período sem movimento)**
- **Dado** um intervalo em que nada aconteceu
- **Quando** o extrato é pedido
- **Então** o PDF sai assim mesmo, com os dois saldos iguais e a frase "Sem movimento no período". Um extrato vazio é resposta; um erro 404 é o tutor achando que o sistema perdeu os dados dele

**AC-04 (Edge Case — extrato não é arquivado)**
- **Dado** qualquer extrato emitido
- **Quando** a emissão conclui
- **Então** **nenhuma** linha entra em `documents` e nenhum objeto vai ao bucket. O extrato descreve o presente; guardá-lo produziria um arquivo que contradiz o sistema no dia seguinte

**AC-05 (Edge Case — saldo com o sinal certo)**
- **Dado** um tutor com saldo negativo
- **Quando** o extrato é renderizado
- **Então** o texto diz **"em aberto"**, usando `portalOwesCents` / `portalCreditCents` de `shared-types/portal.ts`. Negativo é dívida (RN-02 do MOD-LEDGER), e este é exatamente o ponto em que o Portal já errou uma vez

---

### [MOD-DOC-10] — Entrega ao Tutor

> **Como ficou, na implementação da fatia 4:** o Portal **lê `documents` direto** e assina
> a URL ele mesmo, em vez de perguntar por HTTP a três serviços diferentes o endereço de
> um arquivo cuja chave ele acabou de ler sob RLS. Assinar é cálculo local, e não escrita:
> `lib/document-urls.ts` é o gêmeo somente-leitura do `photo-urls.ts` e **não tem `put`**
> — quem grava documento continua sendo o serviço que sabe montá-lo, com o contador de
> tentativas e o job de reprocesso dele.
>
> O documento `PENDING` **entra na lista sem link**, em vez de sumir: quem acabou de pagar
> precisa ver que o recibo está a caminho. O `CANCELLED` sai — é papel sem efeito.
>
> Aqui também se fechou o AC-02 de MOD-DOC-07: o aceite pelo Portal entra pela porta que
> assina escrita (`tutor-port.ts`), com `source = PORTAL` fixado nela — como o `purpose` do
> consentimento —, e o IP e o user-agent do tutor viajam nos headers, porque é deles que a
> prova é feita.

**AC-01 (Happy Path — Meus Documentos)**
- **Dado** um tutor com recibos, um receituário e um termo aceito
- **Quando** abre a área de documentos no Portal
- **Então** vê a lista em ordem decrescente de emissão, com tipo, número, data e o pet quando houver, e baixa qualquer um deles

**AC-02 (Cenário negativo — documento de outro titular)**
- **Dado** o identificador de um documento de outro tutor do mesmo tenant
- **Quando** pede o download
- **Então** **404** `ERR_DOC_001`

**AC-03 (Edge Case — o que o Portal não lista)**
- **Dado** documentos internos do tenant (os dois relatórios de cobrança, por exemplo)
- **Quando** a lista do Portal é montada
- **Então** eles não aparecem, porque não têm `tutor_id` como sujeito. A lista é filtrada por titularidade, não por tipo — assim um tipo novo não vaza por esquecimento

**AC-04 (Edge Case — envio por WhatsApp)**
- **Dado** um documento que o petshop quer mandar pelo WhatsApp
- **Quando** a mensagem é montada
- **Então** vai o **link** para o Portal, nunca o arquivo. Anexo por WhatsApp cai nas regras de mídia da Evolution, engorda a fila e some do histórico do tutor; anexo por e-mail é do MOD-NOTIF e é o caminho certo para isso

---

### [MOD-DOC-11] — Reprocesso e Degradação

**AC-01 (Happy Path — o Gotenberg está fora)**
- **Dado** um ambiente sem Gotenberg configurado ou com ele fora do ar
- **Quando** um documento arquivável é emitido
- **Então** o registro nasce `PENDING` com número já alocado, `last_error` preenchido, e a operação de negócio que o originou **conclui normalmente**. É a mesma escolha que o recibo já faz hoje: nenhum pagamento cai porque um comprovante não imprimiu

**AC-02 (Happy Path — reprocesso)**
- **Dado** documentos `PENDING` com menos de 10 tentativas
- **Quando** o job `document-retry` roda
- **Então** ele tenta reemitir, incrementa `attempts`, e o que passa vai a `ISSUED`. O job usa o lease em Postgres do `packages/job-scheduler`, como os outros oito

**AC-03 (Cenário negativo — a tela não oferece o que não funciona)**
- **Dado** um tenant cujo ambiente não tem PDF configurado
- **Quando** a tela carrega
- **Então** o botão de emitir aparece desabilitado com a razão, alimentado pelo `isConfigured()` do `packages/pdf`. Oferecer um botão que sempre falha é pior que não ter botão

**AC-04 (Edge Case — desistência)**
- **Dado** um documento que falhou 10 vezes
- **Quando** o job o encontra
- **Então** vai a `FAILED`, sai da fila, e a pendência aparece no **sino da topbar** — que passa a ter seis fontes. Falha silenciosa em documento com valor legal é a pior categoria de falha silenciosa

> **O que continua em aberto ao fim do módulo (2026-09-07):** a ida a `FAILED` e a saída
> da fila estão implementadas desde a fatia 1; a **sexta fonte do sino, não**. Falta a ela
> um destino: o sino aponta para a tela onde a pendência se resolve, e no Admin não existe
> tela de documentos — recibo, receituário e termo são vistos cada um dentro do seu
> assunto. Uma linha no sino sem para onde levar é pior que nenhuma. O caminho, quando for
> a hora: uma tela de documentos do estabelecimento, e a contagem por trás dela.

---

### [MOD-DOC-12] — Verificação de Autenticidade *(especificado, não implementado)*

Todo documento arquivado carrega no rodapé um código curto derivado do `checksum` e uma URL pública `{slug}.{dominio}/verificar/{codigo}`, que responde apenas **existe / não existe**, com tipo, data de emissão e o nome do estabelecimento — nunca o conteúdo, nunca o nome do tutor. Serve ao caso real de um terceiro (outro veterinário, um condomínio que exige carteira de vacinação, um seguro) querendo saber se o papel é verdadeiro. Fica fora da v1 porque exige uma superfície pública nova, com o seu próprio rate limit e a sua própria análise de enumeração — e porque nenhum cliente pediu ainda.

---

## 4. Modelo de Dados

### Tabelas Novas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| documents | id | UUID | ✓ | PK |
| documents | tenant_id | UUID | ✓ | Isolamento multi-tenant (RLS) |
| documents | kind | Enum | ✓ | `RECEIPT`, `PRESCRIPTION`, `TERM_ACCEPTANCE`, `IMAGE_CONSENT` |
| documents | number | VarChar(24) | ✓ | Série do §MOD-DOC-03 |
| documents | tutor_id | UUID | — | Sujeito; nulo em documento sem titular |
| documents | pet_id | UUID | — | Sujeito secundário (receituário) |
| documents | storage_key | Text | — | Chave no R2; nulo enquanto `PENDING` |
| documents | checksum | Char(64) | — | SHA-256 do arquivo; base do código do §12 |
| documents | size_bytes | Int | — | Custódia e diagnóstico |
| documents | status | Enum | ✓ | `PENDING`, `ISSUED`, `FAILED`, `CANCELLED` |
| documents | term_version_id | UUID | — | Só em `TERM_ACCEPTANCE` / `IMAGE_CONSENT` |
| documents | issued_at | Timestamptz | — | Momento da emissão |
| documents | retention_until | Date | — | Fim da guarda obrigatória (§9) |
| documents | attempts / last_error | Int / Text | ✓ / — | Reprocesso não cego |
| documents | created_by / created_at / updated_at | UUID / Timestamptz | ✓ | Auditoria |
| document_counters | tenant_id, kind, year | UUID, Enum, Int | ✓ | PK composta |
| document_counters | last_number | Int | ✓ | Alocação por `ON CONFLICT DO UPDATE` |
| prescriptions | id / tenant_id / pet_id | UUID | ✓ | PK e FKs |
| prescriptions | attendance_id | UUID | ✓ | O atendimento de origem |
| prescriptions | vet_id | UUID | ✓ | `professionals.id` do prescritor |
| prescriptions | crmv | VarChar(20) | ✓ | **Snapshot** do registro no dia |
| prescriptions | items_encrypted | Text | ✓ | JSON cifrado com a DEK do tenant |
| prescriptions | instructions_encrypted | Text | — | Orientações ao tutor, cifradas |
| prescriptions | document_id | UUID | — | O PDF em `documents` |
| prescriptions | issued_at | Timestamptz | ✓ | Imutável |
| prescriptions | voided_at / void_reason | Timestamptz / Text | — | Anulação com motivo obrigatório |
| term_versions | id / tenant_id | UUID | ✓ | PK e isolamento |
| term_versions | kind | Enum | ✓ | `TERMS`, `SERVICE_LIABILITY`, `IMAGE_USE` |
| term_versions | version | VarChar(20) | ✓ | Casa com `tutor_consents.version` |
| term_versions | body | Text | ✓ | Markdown restrito |
| term_versions | published_at / published_by | Timestamptz / UUID | ✓ | Publicação é ato auditado |

### Tabelas Alteradas

| Tabela | Mudança | Motivo |
|---|---|---|
| `professionals` | `+ crmv VarChar(20)`, `+ crmv_state Char(2)` | Sem ele a RN-10 do MOD-PRONT é inaplicável (§MOD-DOC-05) |
| `receipts` | `+ document_id UUID`; `storage_key` deixa de ser escrito | Fecha o `document_id` que o schema previa desde o MOD-LEDGER |
| `ConsentChannel` | `+ SERVICE_LIABILITY` | O aceite do termo de responsabilidade reusa `tutor_consents` (§MOD-DOC-07) |
| `receipt_counters` | Migra para `document_counters` com `kind = RECEIPT` | Uma numeração só, sem renumerar nada |

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa |
|---|---|---|
| `items_encrypted` | prescriptions | Prescrição é sigilo profissional veterinário (Res. CFMV 1.138/2016) e campo livre clínico costuma citar o tutor — mesma justificativa que o `observations_encrypted` do MOD-PRONT já usa |
| `instructions_encrypted` | prescriptions | Idem |

> **Contraste que o módulo precisa declarar:** o **PDF arquivado não é cifrado pela aplicação**. Ele vive num bucket privado, só sai por URL assinada de TTL curto, e cifrar o objeto com a DEK do tenant impediria justamente a entrega por URL assinada — que é a única forma de o navegador do tutor baixar o arquivo sem passar centenas de kilobytes pelo serviço. É a mesma escolha que as fotos do MOD-PET fizeram. A questão 3 do §11 registra a alternativa.

### Índices Necessários

```sql
CREATE INDEX idx_documents_tenant_kind     ON documents(tenant_id, kind, issued_at DESC);
CREATE INDEX idx_documents_tenant_tutor    ON documents(tenant_id, tutor_id, issued_at DESC);
CREATE INDEX idx_documents_pending         ON documents(tenant_id, status) WHERE status IN ('PENDING','FAILED');
CREATE UNIQUE INDEX uq_documents_number    ON documents(tenant_id, kind, number);
CREATE INDEX idx_prescriptions_tenant_pet  ON prescriptions(tenant_id, pet_id, issued_at DESC);
CREATE UNIQUE INDEX uq_term_versions       ON term_versions(tenant_id, kind, version);
```

> **Ao gerar a migration:** as quatro tabelas novas entram em `RLS_MODELS` de `packages/db/src/client.ts` **e** ganham policy no SQL — o procedimento com banco-sombra está em `packages/db/prisma/migrations/README.md`, junto do alerta de apagar o `CREATE UNIQUE INDEX "tenants_slug_key"` que o diff insiste em recriar. Um diff futuro também vai querer desfazer o CHECK `appointment_items_values_check`; não deixe.

---

## 5. Contratos de API

Toda rota `/v1` exige o contexto HMAC do `packages/service-auth`; toda rota `/portal/v1` exige contexto com `tutorId`. Documento arquivado responde **302** para URL assinada; documento regerado responde **200** com `application/pdf` no corpo.

### Endpoints

| Método | Path | Serviço | Permissão | Descrição |
|---|---|---|---|---|
| POST | `/v1/attendances/:id/prescriptions` | medical-record | `record:write` + CRMV | Emitir receituário |
| GET | `/v1/pets/:petId/prescriptions` | medical-record | `record:read` | Listar por pet |
| GET | `/v1/prescriptions/:id` | medical-record | `record:read` | Detalhe |
| GET | `/v1/prescriptions/:id/pdf` | medical-record | `record:read` | Arquivo (302) |
| POST | `/v1/prescriptions/:id/void` | medical-record | `record:void` | Anular com motivo |
| GET | `/v1/terms/:kind` | tutor | `tutor:read` | Texto vigente |
| GET | `/v1/terms/:kind/versions` | tutor | `tenant:read_settings` | Histórico |
| POST | `/v1/terms/:kind/versions` | tutor | `tenant:configure` | Publicar versão |
| POST | `/v1/tutors/:id/terms/:kind/accept` | tutor | `tutor:update` | Registrar aceite (balcão) |
| GET | `/v1/documents` | tutor | `tutor:read` | Lista filtrada por tipo e sujeito |
| GET | `/v1/documents/:id/pdf` | tutor | conforme o tipo | Arquivo (302) |
| GET | `/v1/ledger/accounts/:tutorId/statement/pdf` | billing-ledger | `finance:read` | Extrato (200, bytes) |
| GET | `/portal/v1/documents` | portal-bff | `tutor:read_own` | Meus documentos |
| GET | `/portal/v1/documents/:id/pdf` | portal-bff | `tutor:read_own` | Arquivo (302) |
| POST | `/portal/v1/terms/:kind/accept` | portal-bff | `tutor:update_own` | Aceite pelo Portal |
| GET | `/portal/v1/finance/statement/pdf` | portal-bff | `finance:read_own` | Extrato (200, bytes) |

> **Nenhuma permissão nova.** O total continua em **55**, e nenhum `pnpm db:seed` é exigido por este módulo. A permissão de um documento é a permissão do **assunto** dele: receituário é `record:read`, extrato é `finance:read`, termo é `tutor:read`. Criar `document:read` faria alguém com acesso a documentos ler prontuário por um caminho lateral.

### Schema Zod — `packages/shared-types/src/document.ts`

```typescript
import { z } from 'zod'

export const DocumentKindSchema = z.enum([
  'RECEIPT', 'PRESCRIPTION', 'TERM_ACCEPTANCE', 'IMAGE_CONSENT',
])

export const TermKindSchema = z.enum(['TERMS', 'SERVICE_LIABILITY', 'IMAGE_USE'])

export const PrescriptionItemSchema = z.strictObject({
  drug: z.string().min(2).max(120),
  concentration: z.string().max(60).optional(),
  dosage: z.string().min(1).max(120),
  frequency: z.string().min(1).max(120),
  durationDays: z.number().int().min(1).max(365),
})

export const CreatePrescriptionSchema = z.strictObject({
  items: z.array(PrescriptionItemSchema).min(1).max(20),
  instructions: z.string().max(2000).optional(),
})

export const PublishTermVersionSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+$/).max(20),
  body: z.string().min(200).max(50_000),
})

export const AcceptTermSchema = z.strictObject({
  version: z.string().max(20),
})
```

> **Use `z.strictObject`, não `z.object`.** O `z.object` descarta chave desconhecida em silêncio; foi assim que o `AutomationConfigSchema` do MOD-CRM respondia 200 gravando campo que não existia. E ao escrever o PATCH de configuração de documentos, lembre que `.partial()` **não** remove `.default()` — o padrão de dois schemas está em `zod-partial-nao-remove-default`.

### Códigos de Erro

| Código | HTTP | Cenário |
|---|---|---|
| ERR_DOC_001 | 404 | Documento não encontrado para este tenant ou titular |
| ERR_DOC_002 | 422 | Dados insuficientes para emitir (tenant sem endereço, sujeito incompleto) |
| ERR_DOC_003 | 403 | Permissão insuficiente sobre o assunto do documento |
| ERR_DOC_004 | 409 | Documento ou versão de termo imutável |
| ERR_DOC_005 | 503 | Geração de documento indisponível |
| ERR_DOC_006 | 409 | Termo já aceito nesta versão |
| ERR_DOC_007 | 422 | Versão de termo inexistente ou não publicada |
| ERR_DOC_008 | 409 | Numeração indisponível |

`ERR_LEDGER_013` ("Geração de documento indisponível", 503) já existe e passa a ser sinônimo de `ERR_DOC_005`. Fica no catálogo por compatibilidade com o que o Portal já trata; nenhuma rota nova o emite.

---

## 6. Máquinas de Estado

### Documento — `documents.status`

```
        (emissão pedida, número alocado)
                    │
                    ▼
                 PENDING ──────(render + upload OK)──────► ISSUED
                    │                                        │
                    │◄──(job document-retry, attempts < 10)  │
                    │                                        │
        (attempts = 10)                              (anulação do assunto:
                    │                          prescrição anulada, recibo cancelado)
                    ▼                                        │
                 FAILED                                      ▼
                                                        CANCELLED
```

`ISSUED` nunca volta para `PENDING`, e o arquivo nunca é sobrescrito. `CANCELLED` **mantém** o arquivo e o número — muda o que o sistema diz sobre ele, não o que foi entregue.

### Aceite de Termo — leitura sobre `tutor_consents`

```
SEM_ACEITE ──(aceite na versão vigente)──► ACEITO
                                             │
                     (tenant publica versão nova)
                                             ▼
                                     PENDING_RENEWAL ──(novo aceite)──► ACEITO
                                             │
                                    (revogação: granted = false)
                                             ▼
                                          REVOGADO
```

Não há coluna de estado: o estado é **derivado** das linhas append-only, como `mapper.ts` do tutor-service já faz para `TERMS`. Isso é o que garante que a história seja reconstruível.

**Efeitos colaterais por transição:**

| De | Para | Evento | Notificações | Audit Log |
|---|---|---|---|---|
| PENDING | ISSUED | `documento.emitido` | e-mail com anexo (MOD-NOTIF); link no Portal | ✓ |
| PENDING | FAILED | `documento.falhou` | pendência no sino da topbar | ✓ |
| ISSUED | CANCELLED | `documento.cancelado` | — | ✓ |
| — | prescrição emitida | `prescricao.emitida` | e-mail ao tutor com o receituário | ✓ |
| — | aceite registrado | `termo.aceito` | — | ✓ |

---

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | O que se arquiva | Só documento com valor legal: recibo, receituário, termo aceito, autorização de imagem. Extrato e relatório são regerados | MOD-LEDGER, MOD-PORTAL |
| RN-02 | Como se entrega | Arquivado desce por URL assinada de 15 min; regerado desce em bytes com `Content-Disposition` | MOD-PORTAL |
| RN-03 | Imutabilidade | Documento `ISSUED` nunca é regerado nem sobrescrito. Correção é documento novo, com o anterior cancelado e visível | MOD-PRONT, MOD-LEDGER |
| RN-04 | Numeração não recicla | Número de documento cancelado não volta para a série | MOD-LEDGER |
| RN-05 | Prescrição exige CRMV | Sem `professionals.crmv`, `403 ERR_PRONT_009`. É a RN-10 do MOD-PRONT, finalmente aplicável | MOD-PRONT, MOD-IDENT |
| RN-06 | Snapshot vence cadastro | CRMV, nome do tutor, endereço do tenant e preços entram no documento como estavam no dia. Alterar o cadastro não reescreve documento emitido | MOD-IDENT, MOD-TUTOR |
| RN-07 | Emissão não derruba negócio | Falha de Gotenberg ou de bucket deixa o documento `PENDING` e **não** propaga erro para a operação de origem | MOD-LEDGER, MOD-PRONT |
| RN-08 | Escape obrigatório | Todo campo livre passa por `escapeHtml` antes do HTML. O Gotenberg é um Chromium; HTML não escapado é execução | transversal |
| RN-09 | Recibo não é nota fiscal | O aviso do RN-20 do MOD-LEDGER sai do código, não do texto livre do tenant, e vale para todo documento financeiro | MOD-LEDGER, jurídico |
| RN-10 | Aceite é prova, não estado | O aceite grava linha em `tutor_consents` com versão, IP e user-agent; o PDF é consequência, não substituto | MOD-TUTOR |
| RN-11 | Versão publicada é imutável | Editar o texto que alguém aceitou é falsificar contrato. Só se publica versão nova | MOD-TUTOR, MOD-SEC |
| RN-12 | Termo não bloqueia atendimento | `PENDING_RENEWAL` pede novo aceite e não impede o serviço | MOD-AGENDA, MOD-PRONT |
| RN-13 | Titularidade do documento | Documento com `tutor_id` só é visível ao titular no Portal; recurso alheio responde 404 | MOD-PORTAL |
| RN-14 | Alerta crítico no receituário | Alergia `CRITICAL` do pet aparece em destaque no PDF, sempre | MOD-PRONT, MOD-PET |
| RN-15 | Canal de entrega | WhatsApp manda link; e-mail manda anexo. Arquivo não entra na fila da Evolution | MOD-CRM, MOD-NOTIF |
| RN-16 | Concorrência na numeração | `INSERT … ON CONFLICT DO UPDATE … RETURNING` numa instrução, sobre `document_counters`. Sem `SEQUENCE`, sem trava explícita | MOD-LEDGER |
| RN-17 | Retenção | Documento fiscal e clínico: 5 anos a partir da emissão, em `retention_until`. Nada é apagado antes disso, nem por pedido de exclusão do titular | MOD-PORTAL, jurídico |

---

## 8. Eventos RabbitMQ

Exchange `petshop.events` (topic), DLX com backoff 1s / 5s / 30s / 5min.

| Evento | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `documento.emitido` | serviço emissor | notification, audit | `{ tenantId, documentId, kind, number, tutorId?, petId?, timestamp }` |
| `documento.falhou` | serviço emissor | admin (sino), audit | `{ tenantId, documentId, kind, attempts, error, timestamp }` |
| `documento.cancelado` | serviço emissor | audit | `{ tenantId, documentId, kind, reason, timestamp }` |
| `prescricao.emitida` | medical-record | notification, audit | `{ tenantId, prescriptionId, documentId, petId, tutorId, vetId, timestamp }` |
| `termo.aceito` | tutor | crm, audit | `{ tenantId, tutorId, kind, version, source, timestamp }` |

> O `prescricao.emitida` já estava previsto no §8 do `prontuario_04.md` apontando para um `document-service` que não nasce. O nome fica; o consumidor muda.

> **A dívida do outbox continua valendo.** `packages/service-kit/src/events.ts` publica best-effort depois do commit: um evento perdido aqui é um e-mail que não sai, não um documento que não existe — o documento está no banco. É por isso que a reemissão é **job varredor** sobre `documents`, e não só reação a evento.

---

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | TENANT_ADMIN | MANAGER | VET | GROOMER | RECEPTIONIST | DRIVER | TUTOR |
|---|---|---|---|---|---|---|---|
| Emitir receituário | — | — | ✓ (com CRMV) | — | — | — | — |
| Ler receituário | ✓ | ✓ | ✓ | — | — | — | ✓ próprio |
| Anular receituário | ✓ | — | ✓ | — | — | — | — |
| Publicar versão de termo | ✓ | — | — | — | — | — | — |
| Registrar aceite | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ próprio |
| Emitir extrato | ✓ | ✓ | — | — | ✓ | — | ✓ próprio |
| Baixar documento arquivado | ✓ | ✓ | conforme assunto | — | conforme assunto | — | ✓ próprio |

O `DRIVER` não vê documento nenhum, coerente com o `tutor:read_assigned` que o MOD-TAXI lhe deu: o motorista conhece endereço e telefone da corrida do dia, e nada além disso.

### Audit Log

Geram registro imutável em `audit_logs`: emissão de qualquer documento (`action = document.issued`, com tipo, número e sujeito), **download de documento arquivado** (quem, quando, de qual IP — é o acesso a dado clínico e financeiro, e sem isso não há como responder a um incidente), anulação, publicação de versão de termo, aceite e revogação, e alteração de CRMV.

### Dados Pessoais

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| PDF arquivado (recibo) | dado pessoal | obrigação legal (guarda contábil) | 5 anos | ✓ | — |
| PDF arquivado (receituário) | dado pessoal + saúde animal | execução de contrato / sigilo profissional | 5 anos | ✓ | — |
| PDF arquivado (termo aceito) | dado pessoal | consentimento e prova dele | vínculo + 5 anos | ✓ | — |
| `prescriptions.items_encrypted` | clínico | execução de contrato | 5 anos | ✓ | — |
| `tutor_consents` | prova de consentimento | obrigação legal | append-only, sem exclusão | ✓ | — |

> **O documento não some com o titular.** O MOD-PORTAL-09 entregou o pedido de exclusão do art. 18, e ele **anonimiza o cadastro; não apaga documento emitido**. Recibo é obrigação contábil de cinco anos, receituário é sigilo profissional e termo aceito é a prova de que o consentimento existiu — apagá-lo destruiria justamente a defesa do petshop numa reclamação do próprio titular. A fila de exclusão precisa dizer isso, em português, na tela que a equipe responde.

---

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Cabeçalho do tenant (nome, logo, endereço) | 10 min | `doc:header:{tenantId}` | `tenant.configuracao.atualizada` |
| Texto do termo vigente | 1 h | `doc:term:{tenantId}:{kind}` | publicação de versão nova |
| URL assinada | não se cacheia | — | — |

A URL assinada **nunca** entra em cache compartilhado: ela é credencial de acesso a arquivo, e cache de credencial é vazamento com TTL.

### Métricas (Pino estruturado)

```json
{ "metric": "document_issued", "tenantId": "...", "kind": "PRESCRIPTION", "durationMs": 0 }
```

- `document_issued` — emissões por tipo, com a duração da conversão. É o alarme do Gotenberg antes de o usuário reclamar.
- `document_failed` — falhas por tipo e causa; qualquer valor sustentado acima de zero é incidente.
- `document_pending_age` — idade do documento pendente mais antigo. É a métrica que revela job travado, que nenhuma contagem de falha revela.
- `term_acceptance` — aceites por tipo e origem (balcão × Portal).

**Nenhum job roda na suíte** (`DISABLE_JOBS=true` nos harnesses); para exercitar o `document-retry`, use `runJobNow('document-retry')`. E lembre do `resetEnvCache()` no harness: `lib/logger.ts` chama `loadEnv()` no corpo do módulo, e um teste que importe um módulo do serviço antes do harness congela o ambiente sem erro nenhum.

---

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | Texto jurídico dos termos padrão (responsabilidade e uso de imagem). O módulo entrega o mecanismo; o conteúdo semeado precisa de revisão jurídica antes de ir a qualquer tenant | Todo tenant que não publicar o próprio texto | Jurídico + PM | Antes do primeiro deploy da Fase 6 |
| 2 | NFS-e. O tenant vai cobrar isso cedo, é obrigação municipal dele, e o recibo com o aviso do RN-09 só adia a pergunta | MOD-LEDGER, posicionamento do produto | PM + jurídico | Fase 6 (herdada da questão 2 do PRD 05) |
| 3 | Cifrar o PDF no bucket. Hoje o objeto é privado e sai por URL assinada, sem cifra da aplicação. Cifrar impede a entrega por URL assinada e obriga a passar o arquivo pelo serviço | Custo, latência e superfície de exposição | Tech Lead | Fase 7 (MOD-SEC) |
| 4 | Retenção de 5 anos: confirmar com contador se cobre recibo e se o receituário segue prazo distinto do CFMV | MOD-DOC, MOD-ADMIN | PM + contador | Fase 6 |
| 5 | Comprovante de agendamento ficou fora da v1 por decisão de 2026-09-07. Revisitar se o balcão pedir | MOD-AGENDA, MOD-PORTAL | PM | Pós-v1 |
| 6 | Unificar `receipts` em `documents` por completo (derrubar `receipts.storage_key`) exige janela de convivência. Definir quando | MOD-LEDGER | Tech Lead | Segunda migration da Fase 6 |
| 7 | Assinatura ICP-Brasil para prescrição de controlados. Exigência crescente, e nenhum petshop pequeno tem certificado hoje | MOD-DOC, jurídico | PM + Tech Lead | Pós-MVP (herdada da questão 2 do PRD 04) |
