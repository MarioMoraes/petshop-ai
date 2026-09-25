# PRD Detalhado — Controle de Estoque

**Módulo:** MOD-ESTOQUE
**Arquivo:** 16/16
**Prioridade:** P1
**Fase de Implementação:** 9 — Pós-lançamento
**Módulo Backend:** `backend/app/src/modules/inventory`
**Tabelas Principais:** products, stock_lots, stock_movements, product_sales, product_sale_items
**Data:** 2026-09-25
**Status:** Entregue — fatias 1 a 4 (cadastro, lote, entrada, ajuste, saldo, venda, estorno, consumo no atendimento, uso interno, rastreio de lote, alertas no sino, posição em PDF e reconciliação)

---

## 1. Visão Geral

**Contexto de negócio.** O petshop tem duas relações com mercadoria, e o produto não cobria nenhuma
das duas. A primeira é a **venda no balcão**: ração, petisco, coleira, antipulgas. Hoje ela
acontece fora do sistema, ou vira um lançamento manual `PRODUCT` sem nenhum vínculo com o que saiu
da prateleira. A segunda é o **insumo do serviço**: o shampoo do banho, a vacina, o vermífugo. A
vacina é a que dói. A RN-11 do prontuário pede o lote para rastrear uma reação alérgica que só
aparece dois dias depois, mas o lote é digitado à mão (`attendance_items.products_used`, JSON livre).
Ninguém sabe dizer quais pets receberam o lote que o fabricante acabou de recolher, nem quantas doses
sobraram na geladeira.

**Recorte deliberado.** Este módulo **não é um ERP de compras** nem um PDV fiscal. Ele sabe o que
entrou, o que saiu e por quê, lote a lote. Ficam de fora: pedido de compra ao fornecedor, cadastro de
fornecedor, nota fiscal de entrada (XML) e de saída (NFC-e), custo médio contábil, inventário
multi-depósito e leitura de código de barras por câmera. Os dois últimos cabem no modelo sem
migração destrutiva (Questões 2 e 3).

**Por que agora.** O PRD da agenda (`agenda_operacao_06.md:18`) e o do financeiro
(`financeiro_tutor_05.md:22`) deixaram o estoque de fora da v1 de propósito. Os dois pontos de encaixe
ficaram prontos sem uso: `EntryCategory.PRODUCT` existe no razão, e `products_used` existe no item do
atendimento.

**Integração sistêmica.**
- **Upstream:**
  - MOD-PRONT: o atendimento consome insumo rastreável;
  - MOD-IDENT: papéis e plano.
- **Downstream:**
  - MOD-LEDGER: a venda gera débito `PRODUCT` na conta do tutor;
  - MOD-PORTAL e app: o extrato mostra o produto comprado;
  - sino de pendências: validade e reposição;
  - MOD-DOC: relatório de posição em PDF;
  - MOD-SEC: trilha de auditoria.

**Plano.** Recurso `INVENTORY`, do Pro para cima. Descer de plano **não apaga nada**: as telas somem, e o
prontuário volta a aceitar o produto como texto livre.

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-ESTOQUE-01 | Cadastro de Produto | Produto de venda, de insumo ou dos dois; unidade, preço, custo, ponto de reposição | Must Have |
| MOD-ESTOQUE-02 | Lote e Validade | Saldo por lote; validade obrigatória quando o produto a exige | Must Have |
| MOD-ESTOQUE-03 | Entrada de Mercadoria | Entrada por lote, com quantidade e custo unitário | Must Have |
| MOD-ESTOQUE-04 | Ajuste e Perda | Correção de contagem e baixa por vencimento, quebra ou furto, sempre com motivo | Must Have |
| MOD-ESTOQUE-05 | Venda no Balcão | Venda com baixa por lote e débito `PRODUCT` na conta do tutor (ou avulsa, sem tutor) | Must Have |
| MOD-ESTOQUE-06 | Estorno de Venda | Devolve ao lote de origem e estorna o débito por contrapartida | Must Have |
| MOD-ESTOQUE-07 | Consumo no Atendimento | O produto usado no atendimento aponta para o lote e dá baixa; edição por delta, anulação devolve | Must Have |
| MOD-ESTOQUE-08 | Baixa de Uso Interno | Consumo não rastreável por pet (shampoo, algodão), lançado pela equipe do banho e tosa | Should Have |
| MOD-ESTOQUE-09 | Alertas de Validade e Reposição | Lote vencendo em 30 dias e produto abaixo do mínimo viram pendência no sino | Must Have |
| MOD-ESTOQUE-10 | Rastreio de Lote | "Quais pets receberam o lote X": a consulta que justifica o módulo para a clínica | Should Have |
| MOD-ESTOQUE-11 | Posição e Valorização | Relatório de saldo × custo em PDF | Nice to Have |
| MOD-ESTOQUE-12 | Reconciliação | Job diário compara o saldo materializado com a soma dos movimentos | Must Have |

## 3. Critérios de Aceite

### [MOD-ESTOQUE-01] — Cadastro de Produto

**AC-01** Dado um `TENANT_ADMIN` em plano Pro, quando ele cadastra um produto com nome, tipo
(`RETAIL`, `SUPPLY` ou `BOTH`) e unidade, então o produto nasce ativo e com saldo zero, sem nenhum
lote.

**AC-02** Dado um produto `RETAIL` ou `BOTH`, quando ele é salvo sem preço de venda, então o sistema
recusa com `ERR_INV_002`. Produto `SUPPLY` não tem preço de venda.

**AC-03** Dado um produto com movimento, quando alguém tenta excluí-lo, então o sistema recusa com
`ERR_INV_004` e oferece desativar. O produto desativado some dos seletores e continua no histórico.

**AC-04** Dado um tenant no plano Starter, quando qualquer rota `/v1/inventory` é chamada, então a
resposta é 402 `ERR_PLAN_001`.

### [MOD-ESTOQUE-02/03] — Lote, Validade e Entrada

**AC-01** Dado um produto com `tracks_expiry = true`, quando a entrada é registrada sem validade,
então o sistema recusa com `ERR_INV_003`.

**AC-02** Dado um lote que já existe para o produto (mesmo `batch_code`), quando nova entrada chega
com o mesmo código, então a quantidade **soma no lote existente**. Se a validade informada divergir
da gravada, a entrada é recusada com `ERR_INV_005`: lote com duas validades é erro de digitação.

**AC-03** Dada uma entrada, então ela grava um movimento `PURCHASE_IN` e atualiza
`products.cost_cents` com o custo unitário da entrada (último custo, RN-09).

**AC-04** Dado um produto sem controle de lote (ração em saco, acessório), quando a entrada é
registrada sem código de lote, então o sistema usa o lote implícito `SEM-LOTE` do produto. O saldo
continua sendo por lote, e o caso simples não pede ao operador um campo que ele não tem.

### [MOD-ESTOQUE-04] — Ajuste e Perda

**AC-01** Dado um ajuste, quando o motivo está vazio, então o sistema recusa com `ERR_INV_006`.

**AC-02** Dada uma contagem física, quando o operador informa o **saldo contado**, e não a diferença,
então o sistema calcula o delta e grava um `ADJUSTMENT` com ele. Quem conta a prateleira sabe quantos
tem, não quantos sumiram.

**AC-03** Dado um lote vencido, quando o operador aciona "descartar", então todo o saldo sai num
movimento `LOSS` com motivo `EXPIRED`.

### [MOD-ESTOQUE-05] — Venda no Balcão

**AC-01** Dado um carrinho com itens e um tutor, quando a venda é confirmada, então, **na mesma
transação**:
- cada item dá baixa por FEFO (RN-04), ou no lote escolhido;
- um débito `PRODUCT` com o total entra na conta do tutor;
- a venda nasce `COMPLETED`.

**AC-02** Dado um item cujo saldo somado nos lotes é menor que a quantidade pedida, quando a venda é
confirmada, então **toda** a venda é recusada com `ERR_INV_010`, e a resposta lista o disponível por
produto.

**AC-03** Dadas duas vendas simultâneas da última unidade, então exatamente uma é gravada e a outra
recebe `ERR_INV_010` (RN-05).

**AC-04** Dada uma venda sem tutor (cliente de passagem), então ela dá baixa e **não** gera
lançamento no razão. O pagamento de balcão avulso não tem conta onde cair (Questão 1).

**AC-05** Dada uma repetição do mesmo `idempotencyKey` com o mesmo corpo, então a resposta é 200 com
a venda já gravada, sem segunda baixa.

**AC-06** Dado o limite de crédito do tenant configurado e o tutor acima dele, quando a venda é
confirmada, então vale a mesma regra do agendamento (RN-15 do MOD-LEDGER): o sistema alerta, e só o
`TENANT_ADMIN` passa, com justificativa.

### [MOD-ESTOQUE-06] — Estorno de Venda

**AC-01** Dada uma venda `COMPLETED`, quando o `TENANT_ADMIN` a estorna com motivo, então:
- cada item volta ao **lote de onde saiu** (`RETURN_IN`);
- o débito é estornado por contrapartida (`reverseEntry`);
- a venda passa a `REVERSED`.

**AC-02** Dado um lote que venceu entre a venda e o estorno, então a devolução entra mesmo assim. O
lote vencido aparece no alerta, e quem decide descartar é o operador.

**AC-03** A recepção não estorna (RN-25 do MOD-LEDGER): `inventory:refund` é só do `TENANT_ADMIN`.

### [MOD-ESTOQUE-07] — Consumo no Atendimento

**AC-01** Dado um atendimento em que o veterinário informa o produto e o lote usados, então
`products_used` grava `{ productId, lotId, quantity, name, batch }` e o lote recebe um movimento
`CONSUMPTION_OUT` com `source_id = attendance_item.id`. `name` e `batch` continuam congelados no
item: o prontuário não depende do cadastro.

**AC-02** Dada a edição do atendimento dentro da janela de 24h (RN-05 do MOD-PRONT), quando a
quantidade muda de 2 para 1, então o sistema grava um movimento de +1, **o delta**, e não um estorno
seguido de nova baixa.

**AC-03** Dado um lote cujo saldo não cobre o consumo, então a baixa **grava assim mesmo** e o lote
fica negativo (RN-06). A pendência "saldo negativo" aparece no sino.

**AC-04** Dada a anulação do atendimento, então tudo o que ele consumiu volta ao lote de origem num
`VOID_RETURN`.

**AC-05** Dado um tenant sem `INVENTORY`, então o campo aceita texto livre como hoje, e nenhum
movimento é gravado.

**AC-06** Dado um produto com `tracks_expiry = true`, quando o lote escolhido está vencido na data do
atendimento, então o sistema recusa com `ERR_INV_011`. Aplicar vacina vencida não é alerta, é erro.

### [MOD-ESTOQUE-08] — Baixa de Uso Interno

**AC-01** Dado um `GROOMER` ou `BATHER`, quando ele lança "usei 1 frasco de shampoo X", então o
sistema grava `CONSUMPTION_OUT` sem vínculo com atendimento, por FEFO e com o autor.

**AC-02** A baixa de uso interno aceita só produtos `SUPPLY` ou `BOTH`. Ração vendida não é insumo.

### [MOD-ESTOQUE-09] — Alertas

**AC-01** Dado um lote com saldo positivo e validade em até `expiry_warning_days` (padrão 30), então o
sino mostra "N lotes vencendo" com o link para a lista filtrada.

**AC-02** Dado um produto ativo cujo saldo somado está abaixo de `min_quantity`, então o sino mostra
"N produtos para repor".

**AC-03** O alerta é **leitura de estado, não evento**: some sozinho quando a entrada acontece. Não
há "marcar como lido" (mesmo desenho do sino).

### [MOD-ESTOQUE-10] — Rastreio de Lote

**AC-01** Dado um lote, quando o veterinário abre "quem recebeu", então a tela lista pets, tutores e
datas de todo `CONSUMPTION_OUT` com vínculo a atendimento e de toda venda, **com o telefone só para
quem tem `tutor:read`**.

### [MOD-ESTOQUE-12] — Reconciliação

**AC-01** Diariamente (`inventory.reconciliation`, 04h10), para cada lote,
`quantity_on_hand = Σ movements.quantity`. A divergência grava um evento de segurança e **não
corrige sozinha** (RN-18 do MOD-LEDGER).

## 4. Modelo de Dados

### Decisão de representação

**Quantidade é `Decimal(12,3)`**, não inteiro: insumo se mede em ml e g, e o frasco de 500 ml
consumido em 40 ml por banho é o caso normal. **Dinheiro continua em centavos `BigInt`**, como no
MOD-LEDGER.

**Saldo materializado mais razão de movimentos.** `stock_lots.quantity_on_hand` é o que as telas leem.
`stock_movements` é a verdade, append-only por trigger. Os dois mudam na mesma transação, e a
reconciliação confere a igualdade.

### Tabelas Envolvidas

```prisma
enum ProductKind { RETAIL SUPPLY BOTH }
enum ProductUnit { UN ML G KG L }

model Product {
  id             String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId       String      @map("tenant_id") @db.Uuid
  name           String      @db.VarChar(120)
  sku            String?     @db.VarChar(40)
  barcode        String?     @db.VarChar(40)
  kind           ProductKind
  unit           ProductUnit @default(UN)
  salePriceCents BigInt?     @map("sale_price_cents")
  costCents      BigInt?     @map("cost_cents")        // último custo de entrada
  minQuantity    Decimal     @default(0) @map("min_quantity") @db.Decimal(12, 3)
  tracksExpiry   Boolean     @default(false) @map("tracks_expiry")
  active         Boolean     @default(true)
  createdBy      String?     @map("created_by") @db.Uuid
  createdAt / updatedAt / deletedAt
  @@unique([tenantId, sku])                  // parcial: WHERE sku IS NOT NULL AND deleted_at IS NULL
  @@index([tenantId, active])
  @@map("products")
}

model StockLot {
  id             String    @id
  tenantId       String
  productId      String    @map("product_id")
  batchCode      String    @map("batch_code") @db.VarChar(40)   // 'SEM-LOTE' para o lote implícito
  expiresAt      DateTime? @map("expires_at") @db.Date
  quantityOnHand Decimal   @default(0) @map("quantity_on_hand") @db.Decimal(12, 3)
  unitCostCents  BigInt?   @map("unit_cost_cents")
  createdAt / updatedAt
  @@unique([tenantId, productId, batchCode])
  @@index([tenantId, productId, expiresAt])    // FEFO
  @@map("stock_lots")
}

enum StockMovementType {
  PURCHASE_IN SALE_OUT CONSUMPTION_OUT ADJUSTMENT LOSS RETURN_IN VOID_RETURN
}
enum StockSourceType { ENTRY SALE SALE_ITEM ATTENDANCE_ITEM INTERNAL_USE ADJUSTMENT }

model StockMovement {                              // append-only (trigger)
  id            String            @id
  tenantId      String
  lotId         String            @map("lot_id")
  productId     String            @map("product_id")   // desnormalizado para o histórico do produto
  type          StockMovementType
  quantity      Decimal           @db.Decimal(12, 3)   // com sinal
  quantityAfter Decimal           @map("quantity_after") @db.Decimal(12, 3)
  sourceType    StockSourceType   @map("source_type")
  sourceId      String?           @map("source_id") @db.Uuid
  reason        String?           @db.VarChar(200)
  petId         String?           @map("pet_id") @db.Uuid     // rastreio de lote (MOD-ESTOQUE-10)
  tutorId       String?           @map("tutor_id") @db.Uuid
  createdBy     String?           @map("created_by") @db.Uuid
  occurredAt    DateTime          @map("occurred_at")
  postedAt      DateTime          @default(now()) @map("posted_at")
  @@index([tenantId, productId, occurredAt(sort: Desc)])
  @@index([tenantId, lotId, occurredAt(sort: Desc)])
  @@map("stock_movements")
}

enum ProductSaleStatus { COMPLETED REVERSED }

model ProductSale {
  id              String            @id
  tenantId        String
  tutorId         String?           @map("tutor_id")
  totalCents      BigInt            @map("total_cents")
  status          ProductSaleStatus @default(COMPLETED)
  ledgerEntryId   String?           @map("ledger_entry_id")
  reversalReason  String?           @map("reversal_reason")
  reversedBy / reversedAt
  createdBy / createdAt
  items           ProductSaleItem[]
  @@index([tenantId, tutorId, createdAt(sort: Desc)])
  @@map("product_sales")
}

model ProductSaleItem {
  id              String  @id
  tenantId        String
  saleId          String  @map("sale_id")
  productId       String  @map("product_id")
  label           String  @db.VarChar(120)    // snapshot, como AppointmentItem
  quantity        Decimal @db.Decimal(12, 3)
  unitPriceCents  BigInt  @map("unit_price_cents")
  totalPriceCents BigInt  @map("total_price_cents")
  @@map("product_sale_items")
}
```

**Mudanças em tabelas existentes:**
- `EntrySourceType` ganha `PRODUCT_SALE`. A idempotência do razão, `(tenant_id, source_type,
  source_id, direction)`, protege a venda de débito duplo.
- `ProductUsedSchema` (`shared-types/src/record.ts:323`) ganha `productId?`, `lotId?` e `quantity?`.
  O formato antigo continua válido.
- `billing_settings`, ou uma `inventory_settings` própria, guarda `expiry_warning_days`
  (padrão 30).

### Índices e restrições

- Único parcial `stock_movements (tenant_id, source_type, source_id, lot_id) WHERE source_id IS NOT
  NULL AND type IN ('PURCHASE_IN','SALE_OUT','CONSUMPTION_OUT','RETURN_IN','VOID_RETURN')`: a
  idempotência do movimento. O delta da edição do atendimento usa `source_id` de uma revisão
  (`attendance_item.id` + versão), e por isso não colide.
- `CHECK (quantity <> 0)` em `stock_movements`.
- Trigger `stock_movements_append_only`: recusa `UPDATE` e `DELETE`, exceto o `DELETE` de
  `app_maintenance` (exclusão de tenant).
- RLS `tenant_id = current_tenant_id()` nas cinco tabelas, com `FORCE ROW LEVEL SECURITY`.
- As cinco entram no cascade de exclusão de tenant.

## 5. Contratos de API

### Endpoints (`/v1/inventory`, gate `INVENTORY`)

| Método | Rota | Permissão | Descrição |
|---|---|---|---|
| GET | `/v1/inventory/products` | `inventory:read` | Lista com saldo somado, menor validade e flag de reposição; filtros `q`, `kind`, `alert` |
| POST | `/v1/inventory/products` | `inventory:write` | Cria produto |
| GET | `/v1/inventory/products/:id` | `inventory:read` | Detalhe com lotes |
| PATCH | `/v1/inventory/products/:id` | `inventory:write` | Edita; `active=false` desativa |
| DELETE | `/v1/inventory/products/:id` | `inventory:write` | Só sem movimento (`ERR_INV_004`) |
| GET | `/v1/inventory/products/:id/movements` | `inventory:read` | Histórico paginado por cursor |
| POST | `/v1/inventory/entries` | `inventory:write` | Entrada: `{ productId, batchCode?, expiresAt?, quantity, unitCostCents?, idempotencyKey }` |
| POST | `/v1/inventory/adjustments` | `inventory:write` | `{ lotId, mode: COUNT\|DELTA, quantity, reason, type: ADJUSTMENT\|LOSS, idempotencyKey }` |
| POST | `/v1/inventory/internal-use` | `inventory:consume` | `{ productId, quantity, lotId? }` |
| GET | `/v1/inventory/lots/:id/trace` | `inventory:read` + `record:read_summary` | Rastreio de lote |
| GET | `/v1/inventory/sales` | `inventory:read` | Lista de vendas; filtro `tutorId` |
| POST | `/v1/inventory/sales` | `inventory:sell` | `{ tutorId?, items: [{ productId, quantity, lotId? }], creditOverrideReason?, idempotencyKey }` |
| POST | `/v1/inventory/sales/:id/reverse` | `inventory:refund` | `{ reason }` |
| GET | `/v1/inventory/alerts` | `inventory:read` | Contagens para o sino |
| GET | `/v1/inventory/settings` | `inventory:read` | A janela do alerta de validade |
| PATCH | `/v1/inventory/settings` | `inventory:write` | `{ expiryWarningDays }`, de 1 a 180 |
| GET | `/v1/inventory/reports/position` | `inventory:read` | Posição e valorização (JSON) |
| GET | `/v1/inventory/reports/position/pdf` | `inventory:read` | O mesmo relatório em PDF |

O consumo no atendimento **não tem rota própria**: entra pelo `PATCH` do atendimento, que já existe,
e passa pela porta `modules/attendances/inventory-port.ts`.

### Schemas Zod — `packages/shared-types/src/inventory.ts`

`ProductSchema`, `CreateProductSchema` e `UpdateProductSchema` seguem o padrão de dois schemas, sem
`.partial()` sobre default (ver a armadilha do `.partial()` do Zod). Também entram
`StockEntrySchema`, `StockAdjustmentSchema`, `InternalUseSchema`, `CreateSaleSchema`,
`ReverseSaleSchema` e `InventoryAlertsSchema`. A quantidade trafega como **string decimal**, para
não perder precisão no JSON.

### Códigos de Erro

| Código | HTTP | Quando |
|---|---|---|
| `ERR_INV_001` | 404 | Produto ou lote inexistente |
| `ERR_INV_002` | 422 | Dados inválidos — inclui produto de venda sem preço, SKU repetido e unidade trocada depois do primeiro movimento |
| `ERR_INV_003` | 422 | Validade obrigatória ausente |
| `ERR_INV_004` | 409 | Excluir produto com movimento |
| `ERR_INV_005` | 409 | Lote existente com validade divergente |
| `ERR_INV_006` | 422 | Ajuste sem motivo |
| `ERR_INV_007` | 422 | Produto inativo no seletor |
| `ERR_INV_008` | 422 | Uso interno de produto só de venda |
| `ERR_INV_009` | 403 | Permissão insuficiente |
| `ERR_INV_010` | 422 | Saldo insuficiente na venda (com o disponível por produto) |
| `ERR_INV_011` | 422 | Lote vencido no atendimento |
| `ERR_INV_012` | 409 | Venda já estornada |
| `ERR_INV_013` | 409 | `idempotencyKey` repetido com corpo diferente |
| `ERR_INV_014` | 409 | Tentativa de editar ou apagar movimento (texto do trigger; não chega à API) |
| `ERR_INV_015` | 422 | Tutor acima do limite de crédito; o corpo traz `requiresOverride` |

## 6. Máquinas de Estado

**Venda:** `COMPLETED → REVERSED` (terminal). Não há rascunho: o carrinho vive na tela, e a venda
nasce gravada ou não nasce.

**Lote:** não tem estado; o que existe é derivado. "Vencido" é `expires_at < hoje`, "esgotado" é
`quantity_on_hand <= 0`. Um lote nunca é apagado.

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Movimento é imutável | Correção é novo movimento (`ADJUSTMENT`) com motivo; trigger barra `UPDATE`/`DELETE` | MOD-SEC |
| RN-02 | Uma função escreve | `recordMovement(tx, …)` é a única que grava movimento e mexe no saldo, com `SELECT … FOR UPDATE` no lote | — |
| RN-03 | Saldo é por lote | O saldo do produto é a soma dos lotes; não há coluna de saldo no produto | — |
| RN-04 | FEFO | Sem lote escolhido, sai primeiro o de validade mais próxima (nulos por último), depois o mais antigo; uma quantidade pode atravessar lotes | MOD-PRONT |
| RN-05 | Venda serializada | O lock é por lote, na ordem do `id`, para duas vendas cruzadas não travarem uma à outra | — |
| RN-06 | Atendimento não trava por estoque | O serviço já foi prestado; o lote fica negativo e vira pendência. Só a venda recusa saldo insuficiente | MOD-PRONT |
| RN-07 | Consumo por chamada de função | A baixa roda **na transação do atendimento**, por porta, e não por evento: com `DISABLE_EVENTS` não aconteceria, e com broker haveria a janela entre o registro e a baixa (mesmo motivo da RN-06 do MOD-IDENT) | MOD-PRONT |
| RN-08 | Edição é delta | A edição dos produtos do atendimento grava só a diferença; anular devolve o total | MOD-PRONT |
| RN-09 | Custo é o último | `products.cost_cents` é o custo da última entrada; a valorização usa o custo **do lote**. Custo médio contábil fica fora (Questão 4) | — |
| RN-10 | Preço é snapshot | O item da venda congela rótulo e preço; mudar o cadastro não mexe em venda feita | MOD-LEDGER |
| RN-11 | Débito na mesma transação | Venda com tutor grava baixa e débito juntos (`postEntry` pela porta do razão); se um falha, nada grava | MOD-LEDGER |
| RN-12 | Venda avulsa não toca o razão | Sem tutor não há conta; a venda existe só como baixa e registro | MOD-LEDGER |
| RN-13 | Estorno volta ao lote de origem | A devolução usa os `SALE_OUT` da venda, não FEFO | — |
| RN-14 | Vacina vencida é erro | Lote vencido é recusado no atendimento e na venda (`ERR_INV_011`); no uso interno é aviso | MOD-PRONT |
| RN-15 | Descer de plano não apaga | Sem `INVENTORY`: rotas 402, telas somem, a porta do prontuário vira no-op; os dados ficam | MOD-IDENT |
| RN-16 | Reconciliação não corrige | Divergência gera evento de segurança; quem corrige é um ajuste humano | MOD-SEC |
| RN-17 | Anonimização preserva o movimento | O vínculo `tutor_id`/`pet_id` do movimento segue o tutor anonimizado; não há texto livre pessoal no estoque | MOD-TUTOR |
| RN-18 | O Portal vê a venda pelo razão | O tutor vê o débito `PRODUCT` no extrato; não há tela de estoque no Portal nem no app | MOD-PORTAL |

## 8. Eventos RabbitMQ

| Evento | Publisher | Consumers | Payload |
|---|---|---|---|
| `venda.registrada` | inventory | crm (futuro: recompra de ração), audit | `{ tenantId, saleId, tutorId?, totalCents, items: [{ productId, quantity }] }` |
| `venda.estornada` | inventory | audit | `{ tenantId, saleId, reason, reversedBy }` |

**Consome:** nada. O consumo no atendimento é chamada de função (RN-07), e a anulação também passa
pela porta, dentro de `voidAttendance`.

## 9. Segurança & LGPD

### Controle de acesso

| Permissão | TENANT_ADMIN | RECEPTIONIST | VET | GROOMER | BATHER | DRIVER |
|---|---|---|---|---|---|---|
| `inventory:read` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `inventory:write` | ✓ | | | | | |
| `inventory:sell` | ✓ | ✓ | | | | |
| `inventory:refund` | ✓ | | | | | |
| `inventory:consume` | ✓ | | ✓ | ✓ | ✓ | |

A baixa no atendimento não pede permissão de estoque: vai junto da edição do atendimento, que exige `record:write_notes` e ser o autor do registro ou administrador.

### Auditoria

Geram `audit_logs`: criar, editar e desativar produto; entrada; ajuste e perda; venda; estorno. O
movimento de consumo **não** gera um registro próprio, porque a edição do atendimento já gera.

### Dados pessoais

O estoque não guarda dado pessoal próprio: `tutor_id` e `pet_id` são vínculos. O rastreio de lote
mostra o telefone do tutor só para quem tem `tutor:read`.

## 10. Performance & Observabilidade

- A lista de produtos soma lotes com `GROUP BY` sobre `stock_lots`, sem somar movimentos. Com o
  índice `(tenant_id, product_id, expires_at)`, fica bem abaixo de 100 ms para 5 mil produtos.
- As contagens do sino ficam em cache Redis de 60 s por tenant, invalidado em todo movimento.
- Métricas no log: `inventory.sale.completed`, `inventory.stock.negative`,
  `inventory.reconciliation.divergence`.

## 11. Questões em Aberto

1. **Venda avulsa e o caixa.** A venda sem tutor não tem onde registrar o pagamento. A v1 aceita
   essa lacuna. O caminho é um "caixa do dia", que é o começo de um PDV e merece módulo próprio.
2. **Leitura de código de barras.** O campo `barcode` já existe. Leitor USB funciona como teclado e
   não pede nada. A câmera do celular fica para depois.
3. **Mais de um depósito ou unidade.** O saldo é por lote. Um `location_id` em `stock_lots` resolve
   sem migração destrutiva.
4. **Custo médio e margem.** A v1 guarda o custo por lote e o último custo. O relatório de margem por
   venda sai do custo do lote baixado, que o `SALE_OUT` já sabe.
5. **Produto no pacote pré-pago.** O pacote do MOD-LEDGER cobre só serviço. Incluir ração num plano
   mensal fica em aberto.
6. **Kit por serviço.** Baixa automática ("todo banho de porte G consome 60 ml de shampoo") seria a
   evolução natural do MOD-ESTOQUE-08. Fica fora até haver dado de consumo real para calibrar.

## 12. Registro de implementação

**Fatia 1 — 2026-09-25.** Migration `20260928120000_mod_estoque` (products, stock_lots,
stock_movements), módulo `backend/app/src/modules/inventory`, telas em
`frontend/src/app/(admin)/estoque`. Decisões tomadas no caminho:

- **Idempotência por coluna, não por tabela.** `stock_movements.idempotency_key` com índice
  único parcial. A mesma chave com o mesmo produto/lote e quantidade devolve 200 com
  `repeated: true`, e com outra, `ERR_INV_013`.
- **O custo do lote é a média ponderada das entradas dele**, e o do produto é o da última
  entrada (RN-09).
- **Só `inventory:read` e `inventory:write` existem por ora.** `sell`, `refund` e
  `consume` entram com as fatias que as usam, para a matriz não conceder o que ainda não
  existe.
- **A unidade não muda depois do primeiro movimento**, porque ela é o significado de todo
  número já gravado.
- **Produto e lote têm FK `NO ACTION`, e não `RESTRICT`**, para a exclusão do tenant
  apagar os três pelo cascade. O trigger de imutabilidade libera o `DELETE` que chega por
  cascade (`pg_trigger_depth() > 1`) ou por `app_maintenance`.
- **O `P2002` de índice parcial vem com `meta.target: null`**, e por isso a colisão é
  reconhecida pelo modelo, e não pelo nome do índice.

**Fatia 2 — 2026-09-25.** Migration `20260929120000_estoque_venda` (product_sales,
product_sale_items, `EntrySourceType.PRODUCT_SALE`), `inventory/sales.ts` e a porta
`inventory/ledger-port.ts`; telas em `/estoque/vendas`, no diálogo "Vender" de `/estoque` e
na ficha do tutor. Decisões:

- **A porta chama o razão por dentro, e não `createManualEntry`**: `openAccount`, `postEntry`
  e `absorbLeftoverCredit` rodam na transação da venda. Para o estorno, `reverseEntry` foi
  dividido em `reverseEntryInTx` + `announceReversal`, e o comportamento de quem já o
  chamava não mudou.
- **O débito tem `source_type = PRODUCT_SALE` e `source_id` = a venda.** O índice
  `idx_entries_source` já cobria toda origem que não é `MANUAL`, então a proteção contra
  débito duplo veio de graça.
- **Liberar venda acima do limite pede `finance:credit`**, e não uma permissão nova: vender
  fiado acima do limite é conceder crédito. A regra compara a dívida **atual** com o limite,
  como a agenda.
- **Lote vencido não conta como saldo na venda**: o FEFO o pula, e escolhê-lo à mão dá
  `ERR_INV_011`.
- **A trava é de todos os lotes dos produtos da venda, em ordem de `id`**, e não só dos que o
  FEFO escolheria: a escolha precisa ser feita sobre um saldo que não muda até a baixa.
- **O preço fracionado arredonda meio centavo para cima**, por linha: 0,375 kg a R$ 32,90 é
  R$ 12,34.
- **O débito estornado pela tela do financeiro não impede o estorno da venda**: a venda só
  devolve ao estoque. O caminho inverso — estornar pelo financeiro — **não** devolve ao
  estoque: o financeiro não conhece a prateleira.
- **A lista de vendas é de quem vende** (`inventory:sell`), e não de quem lê o estoque: quem
  dá banho não tem por que ver o que o cliente comprou.

**Fatia 3 — 2026-09-25.** Sem migration: o consumo usa as tabelas da fatia 1. Entraram
`inventory/consumption.ts`, a porta `attendances/inventory-port.ts`, `inventory/lots.ts` (a
trava e o FEFO, antes dentro da venda), as rotas `POST /v1/inventory/internal-use` e
`GET /v1/inventory/lots/:id/trace`, e na tela o diálogo "Produtos usados" do atendimento
(linha do tempo do pet), "Registrar uso" e "Quem recebeu" na ficha do produto. Decisões e
correções de premissa:

- **A edição do atendimento exige `record:write_notes`, e não `record:write`.** O PRD dizia
  o contrário. Na prática o tosador e o banhista **também** registram produto no atendimento
  de que são autores. A baixa de uso interno continua existindo, para o que não é de um pet.
- **Antes desta fatia, nenhuma tela editava `products_used`**: o campo só era gravado por
  API. O diálogo "Produtos usados" é a primeira porta de entrada dele no Admin.
- **A diferença é recalculada a partir dos movimentos já gravados para o item**, e não de um
  campo guardado. Repetir a mesma edição não grava nada, e tirar o produto da lista devolve.
- **O mapper do atendimento descartava tudo que não fosse `name` e `batch`.** Passou a
  devolver `productId`, `lotId` e `quantity`. Sem isso, a segunda edição recalcularia a baixa
  sobre uma lista sem lote.
- **A validade é conferida contra a data do atendimento, no fuso do estabelecimento**, e não
  contra hoje: a correção feita no dia seguinte não recusa a vacina que estava boa no dia
  aplicado.
- **A devolução por anulação carrega o pet e o tutor do consumo**, para o rastreio mostrar
  que aquele pet, afinal, não recebeu.
- **Uso interno sem saldo sai negativo**, e o produto sem entrada nenhuma ganha o lote
  implícito negativo, pela RN-06.
- **Sem o plano, a ligação com o estoque é tirada da linha**, que fica como texto (AC-05). A
  devolução da anulação roda com plano ou sem.

**Fatia 4 — 2026-09-25.** Migration `20260930120000_estoque_alertas` (`inventory_settings`),
`inventory/alerts.ts`, `settings.ts`, `position.ts` + `position-template.ts` + `pdf-port.ts`,
`reconciliation.ts` e o job `inventory.reconciliation` (`worker/inventory-jobs.ts`, 04h10).
Na tela: três linhas novas no sino, o botão "Posição em PDF" em `/estoque` (pela rota
`/estoque/posicao/pdf` do Next) e, no filtro "Vencendo", a janela dita acima da lista com
"Mudar o prazo" para o administrador. Decisões e correções de premissa:

- **A janela mora em `inventory_settings`, e não em `billing_settings`** nem em
  `tenant_settings`: é configuração deste módulo, e as outras duas têm dono. A linha ausente
  vale 30, sem backfill. Intervalo de 1 a 180 dias, no Zod e num `CHECK`.
- **O sino conta com as mesmas contas da lista.** `getInventoryAlerts` roda o mesmo
  `toProductResponse` sobre os mesmos produtos (ativos, não excluídos) que o filtro mostra.
  Uma consulta agregada à parte seria uma segunda regra de "vencendo". O número de lotes
  vencendo inclui **os já vencidos com saldo**, como o selo da lista.
- **Três linhas no sino**, na ordem vencendo → saldo negativo → repor, no fim do painel. O
  produto negativo com ponto de reposição conta nas duas últimas, como aparece nas duas
  listas. O sino só pergunta quando o plano tem `INVENTORY` e a pessoa tem `inventory:read`.
- **O cache de 60 s é derrubado dentro da transação**, em `recordMovement` e nas escritas do
  cadastro e da janela. O Prisma não tem gancho de pós-commit: uma leitura que caia entre o
  `DEL` e o commit repõe o número velho por até um minuto, e o TTL limita esse caso.
- **A rota do PDF é `/reports/position/pdf`, e não `position.pdf`**, com a irmã JSON sem o
  sufixo: é o par que os relatórios do financeiro já usam. O erro de Gotenberg fora do ar é
  `ERR_DOC_005`, o código novo do MOD-DOC.
- **A valorização deixa dois casos fora do total, e a folha diz quantos:** o lote sem custo,
  para não fingir um valor, e o lote negativo, para não abater o estoque bom por um registro
  que falta. O lote vencido **conta**, até alguém dar a baixa por perda, e é marcado na linha.
  O produto desativado com saldo entra: desativar tira do seletor, e não da prateleira.
- **A divergência da reconciliação vai para `audit_logs`, e não para `security_events`.** O
  PRD dizia "evento de segurança", mas `SecurityEventType` é um catálogo fechado de tentativas
  de acesso, e um saldo que não fecha não é nenhuma delas. É o mesmo destino da reconciliação
  do razão, e a trilha tem leitor (`GET /v1/audit-logs`). Métrica
  `inventory_reconciliation_divergence_total` e log P1.
- **A reconciliação varre todos os lotes, e não uma janela de 24 h** como a do razão: um
  `GROUP BY` por estabelecimento dá conta de centenas de lotes, e uma janela deixaria de fora
  justamente o lote parado editado à mão. A soma e o saldo saem do mesmo comando, então um
  movimento confirmado no meio da varredura nunca vira falsa divergência.
