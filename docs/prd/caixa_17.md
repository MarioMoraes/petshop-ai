# PRD Detalhado — Caixa do Dia

**Módulo:** MOD-CAIXA
**Arquivo:** 17
**Prioridade:** P1
**Fase de Implementação:** 9 — Pós-lançamento
**Módulo Backend:** `backend/app/src/modules/cash`
**Tabelas Principais:** cash_sessions, cash_movements (e `product_sales.payment_method`, `cash_session_id`, `payment_id`)
**Data:** 2026-09-25
**Status:** Entregue

---

## 1. Visão Geral

A venda avulsa do MOD-ESTOQUE (sem tutor) baixava o estoque e o dinheiro dela não entrava em lugar
nenhum: sem tutor não há conta corrente, e o razão só registra pagamento de tutor. Era a Questão 1 do
PRD `estoque_16.md`. O caixa do dia é a gaveta do balcão com um livro:
- abre com o troco;
- recebe a venda avulsa e o pagamento dos tutores;
- perde a sangria e ganha o suprimento;
- fecha com a contagem contra o esperado, por forma de pagamento.

**Decisões do usuário (2026-09-25):**

| Pergunta | Decisão |
|---|---|
| Tamanho | Caixa com abertura e fechamento (não só um registro da forma de pagamento) |
| Relatórios | A venda avulsa soma nos existentes ("Recebido hoje", "Contas recebidas"), em linha própria |
| Venda para tutor | Opção "pago agora" no diálogo de venda |
| Quantos caixas | Um aberto por estabelecimento |
| Sem caixa aberto | A venda avulsa é recusada; o pagamento de tutor passa e só entra no caixa se houver um |
| Plano | Recurso `CASH_REGISTER`, do Pro para cima |

**Fora do escopo:** caixa por operador, PDV fiscal (NFC-e), integração com maquininha ou PSP,
fechamento cego (o operador vê o esperado ao contar), e reabrir caixa fechado.

## 2. Regras de Negócio

| # | Regra |
|---|---|
| RN-01 | **O esperado é a soma dos movimentos.** `cash_movements` é append-only por trigger; a sessão só guarda o que é dela (troco, e no fechamento a contagem congelada). Não há coluna de saldo. |
| RN-02 | Um caixa aberto por estabelecimento: índice único parcial `WHERE status = 'OPEN'`. |
| RN-03 | O troco inicial é um movimento `OPENING_FLOAT` em dinheiro, e não uma regra do fechamento. |
| RN-04 | Sangria e suprimento são sempre em dinheiro e sempre com motivo. A sangria não passa do dinheiro esperado na gaveta (`ERR_CASH_008`). |
| RN-05 | **Venda avulsa exige caixa aberto** (`ERR_CASH_004`) e forma de pagamento. Sem caixa, a venda inteira é recusada e o estoque não sai. |
| RN-06 | O estorno da venda avulsa devolve o dinheiro **pelo caixa aberto agora**, e não pelo da venda, que pode estar fechado. Sem caixa aberto, o estorno é recusado. |
| RN-07 | **O pagamento de tutor nunca depende do caixa.** Entra nele só se houver um aberto, o plano incluir `CASH_REGISTER`, a forma não for crédito de pacote, e o `receivedAt` for posterior à abertura. |
| RN-08 | O estorno do pagamento tira o valor do caixa onde ele entrou, se esse caixa ainda estiver aberto. Fechado, o fechamento daquele dia não se mexe. |
| RN-09 | "Pago agora": a venda para tutor lança o débito e um pagamento que quita **este** débito (alocação manual), e não o mais antigo pelo FIFO. Paga só o que ficou em aberto depois do crédito solto que o débito já absorveu. |
| RN-10 | Estornar a venda paga na hora estorna o débito; o pagamento vira crédito na conta do tutor. Devolver em dinheiro é estornar o pagamento no Financeiro. |
| RN-11 | O fechamento exige a contagem do dinheiro. As outras formas são opcionais: a não informada fica "não conferida" e **fora da diferença**. |
| RN-12 | Diferença diferente de zero exige justificativa (`ERR_CASH_006`). A contagem, a diferença e a nota ficam congeladas na sessão. |
| RN-13 | Tudo roda na transação de quem grava: a venda e o movimento, o pagamento e o movimento. Por porta: `inventory/cash-port.ts` e `ledger/cash-port.ts`. |
| RN-14 | O movimento não guarda o nome do tutor: ele é lido de `tutors` na hora de mostrar, para a anonimização (art. 18) não deixar cópia. |
| RN-15 | Os relatórios somam a venda avulsa **concluída** pela data da venda, numa coluna própria; a estornada não conta, como o pagamento revertido. O razão a lê pela porta `ledger/walk-in-port.ts`. |

## 3. Contratos de API (`/v1/cash`, gate `CASH_REGISTER`)

| Método | Rota | Permissão | Descrição |
|---|---|---|---|
| GET | `/v1/cash/current` | `cash:read` | O caixa aberto com os movimentos, ou `{ session: null }` |
| GET | `/v1/cash/sessions` | `cash:read` | Histórico, paginado por cursor |
| GET | `/v1/cash/sessions/:id` | `cash:read` | Uma sessão com os movimentos |
| POST | `/v1/cash/sessions` | `cash:operate` | Abre: `{ openingFloatCents }` |
| POST | `/v1/cash/adjustments` | `cash:operate` | `{ type: WITHDRAWAL \| DEPOSIT, amountCents, reason }` |
| POST | `/v1/cash/sessions/:id/close` | `cash:operate` | `{ counts: [{ method, countedCents }], notes? }` |

`POST /v1/inventory/sales` ganhou `paymentMethod`: obrigatório sem tutor, e com tutor significa "pago
agora". O `SaleResponse` devolve o campo, e o `Cashflow` e o `ReceiptsByDayReport` ganharam os totais da
venda avulsa (`walkInCents`/`walkInCount`, `walkIn`).

**Permissões:** `cash:read` e `cash:operate` são do `TENANT_ADMIN` e da `RECEPTIONIST`. Pedem re-seed.

**Erros:** `ERR_CASH_001` a `ERR_CASH_009` (`shared-types/errors.ts`).

## 4. Registro de implementação

**2026-09-25.**
- Migration `20261001120000_caixa_do_dia`.
- Módulo `modules/cash`, com `register.ts` como núcleo transacional e `sessions.ts` como serviço.
- A porta do estoque (`inventory/cash-port.ts`) e as duas do razão (`ledger/cash-port.ts` e `ledger/walk-in-port.ts`).
- Tela `/caixa`, com o detalhe `/caixa/[id]`, e o item "Caixa" no menu, logo abaixo de Financeiro.
- A forma de pagamento e o "Pagou agora" no diálogo de venda.
- A coluna "Vendas avulsas" em "Contas recebidas", na tela e no PDF.
- Testes: 24 em `tests/cash/caixa.test.ts`.

Duas decisões do caminho:
- **`recordPayment` foi dividido em `writePaymentInTx` + `announcePayment`**, como o `reverseEntry` já
  tinha sido na fatia 2 do estoque. O comportamento da rota `POST /v1/payments` não mudou, e a venda
  "pago agora" grava o pagamento na transação dela.
- **A trava do caixa serializa o movimento contra o fechamento.** A venda, a sangria e o pagamento
  travam a sessão aberta (`FOR UPDATE`), e o fechamento também. Uma venda que chega no instante do
  fechamento ou entra antes e é somada, ou não acha caixa aberto.
