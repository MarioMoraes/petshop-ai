# Dores do petshop × o que o PetShop AI resolve

Base para os vídeos de divulgação. Fonte: *Pesquisa de mercado — Nicho de petshop no
Brasil* (agosto de 2026, 39 fontes; PDF original em `~/Desktop/PetShop SaaS.pdf`).
O mapeamento para o sistema foi conferido no código em 2026-09-30.

Legenda da coluna **Plano**: Starter (R$ 149/mês) · Pro (R$ 299/mês) — `PLAN_CATALOG`
em `packages/shared-types/src/plans.ts`. Legenda de **Cobertura**: ✅ resolve ·
◐ resolve em parte · ✗ não temos.

---

## As três dores centrais (a conclusão do relatório)

### Dor 1 — A agenda mora em três lugares e nenhum deles avisa o cliente

- **A cena:** caderno no balcão, WhatsApp lotado de pedidos, recado solto no papel,
  encaixe feito na pressa, cliente cobrando confirmação. "Quando o caderno some, some a
  agenda."
- **O número:** no-show de 20% a 30% em serviço agendado (fornecedores falam em 35%);
  **53% dos que faltam simplesmente esqueceram**. 150 atendimentos × R$ 90 × 20% =
  **R$ 2.700/mês na mesa**. Confirmação por WhatsApp reduz faltas de 40% a 70%.
- **O que o sistema faz:**
  - Agenda por profissional, com duração e preço **por porte** (`ServicePricing`) e
    detecção de conflito — ✅ Starter.
  - Mensagem automática na marcação e **lembrete na véspera** (`appointment_confirmed`,
    `appointment_reminder`) por WhatsApp, e-mail e push do app — ✅ WhatsApp no Pro;
    e-mail no Starter.
  - WhatsApp **sem cobrança por mensagem** (número do próprio petshop pela Evolution) —
    ✅ Pro.
  - Taxa de no-show configurável lançada na conta do tutor — ✅ Starter.
  - Mural do dia: a agenda em tela cheia na parede, substituindo o quadro — ✅ Starter.
  - Importação do sistema anterior / planilha, para sair do caderno sem redigitar — ✅.
- **Onde mostrar:** `/agenda`, `/mural`, o WhatsApp do tutor recebendo o lembrete.
- **Cuidado:** a confirmação de **um toque** ("Confirmo" / "Preciso remarcar") não existe
  como botão. O equivalente é o **agente de IA** (Pro): o tutor responde por escrito e o
  agente cancela ou remarca. Não mostrar botão que não existe.

### Dor 2 — O tutor fica horas sem notícia e a recepção vira central de atendimento

- **A cena:** o tutor entrega o pet e fica 2 a 4 horas sem notícia; liga para saber se
  está tudo bem; a recepção para o que faz para responder; o tosador tira foto no próprio
  celular e ela se perde; se der problema, é a palavra de um contra a do outro.
- **Por que importa:** é **a dor que o relatório diz que nenhum concorrente ataca**. É a
  diferenciação defensável.
- **O que o sistema faz:**
  - Estados do atendimento: agendado → check-in → em atendimento → concluído
    (`AppointmentStatus`) — ✅.
  - Ao concluir, o tutor recebe **"{{pet}} já está pronto(a)"** por WhatsApp, e-mail e
    push (`service_done`) — ✅ (WhatsApp no Pro).
  - Fotos de **antes e depois** presas ao atendimento (`AttendancePhase`); a do "depois"
    aparece no histórico do pet no Portal e no app do tutor — ✅ Pro (Portal/app).
  - **Agente de IA no WhatsApp** responde "já ficou pronto?", "que horas posso buscar?",
    horários livres, saldo — sem a recepção parar — ✅ Pro.
  - Taxi Dog com avisos "a caminho", "chegou", "entregue" — ✅ Pro.
- **Onde mostrar:** check-in/check-out na agenda, o push "pronto" no celular, a foto do
  depois no app do tutor, uma conversa com o agente.
- **Cuidado:** a mensagem de "pronto" sai **sem a foto anexada**; a foto está no
  app/Portal. As etapas finas do quadro de parede (banho, secagem, tosa) não existem como
  estados separados — é "em atendimento".

### Dor 3 — Recorrência e pacotes controlados no escuro

- **A cena:** saldo do pacote anotado num cartãozinho ou na memória da recepção. "Não sei
  quantos banhos ainda restam no pacote do cliente." Saldo errado vira banho de graça,
  atrito e cliente perdido.
- **O que o sistema faz:**
  - Pacotes vendidos ao tutor com consumo por uso (`PackagePurchase`,
    `PackageCreditUsage`) e saldo sempre visível — ✅ Starter.
  - O tutor vê os próprios pacotes e o extrato no Portal e no app — ✅ Pro.
  - Conta corrente do tutor, recibos e extrato em PDF — ✅ Starter.
  - Link de pagamento PIX/cartão (Asaas do próprio petshop) e régua de cobrança
    automática — ✅ Pro.
- **Onde mostrar:** ficha do tutor → pacotes; "Minha conta" no app do tutor.

---

## As outras dores do relatório

| Dor (seção do PDF) | O que temos | Cobertura | Plano |
|---|---|---|---|
| **Histórico do pet só na cabeça do tosador** (3.3) — pet que irritou no banho, tosa entregue diferente do combinado | Ficha do pet com alergias, temperamento, alertas médicos, fotos de antes/depois e histórico de atendimentos | ✅ | Starter |
| **O cliente que some sem reclamar** (3.3) | Campanha de retorno para inativo (`winback`), aniversário do pet e do tutor | ✅ | Pro |
| **WhatsApp como sistema operacional / cada atendente responde de um jeito** (3.2) | Textos padronizados no catálogo de mensagens + agente de IA com histórico | ✅ | Pro |
| **Fechamento de caixa que leva mais de 30 min** (3.2) | Caixa do dia com abertura, movimentos e fechamento com conferência de sobra/falta | ✅ | Pro |
| **Estoque de insumos sem controle, ração vencida** (3.1) | Estoque com lote e validade, consumo de insumo, alerta de reposição, venda avulsa | ✅ | Pro |
| **Captação: link de agendamento na bio do Instagram, Google** (2) | Site do estabelecimento + agendamento online pelo Portal | ✅ | Pro |
| **Foto do antes/depois que se perde** (2, conteúdo de Instagram) | Fotos presas ao atendimento, no armazenamento do sistema | ◐ — guarda e organiza; não publica | Starter |
| **Tosa entregue diferente do combinado** (3.3) | Observações e foto do último corte na ficha | ◐ | Starter |
| **Precificação no chute** (3.1) | Preço e duração por porte por serviço | ◐ — não calcula margem nem custo por serviço | Starter |
| **Comissão calculada errada na sexta-feira** (3.1) | — | ✗ | — |
| **Tutor atrasado no pagamento** | Régua de cobrança (três toques) + link PIX | ✅ | Pro |

---

## O que o relatório diz sobre como falar com esse público

Vale para roteiro, locução e legenda.

- **"Tutor", nunca "dono".** Vocabulário do nicho: banhista, tosador, encaixe, comanda,
  pacote de banho, pet pronto, táxi dog, tosa higiênica, tosa bebê, desembolo.
- **Reconhecer a cena antes de vender:** a agenda de sábado lotada até as 18h e a
  sensação, no fim do dia, de que a grana que entrou não fecha com o trabalho que saiu.
- **Tom:** direto, prático, coloquial, segunda pessoa, com número concreto. Sem
  infantilizar e sem tratar como amador ("você está fazendo tudo errado").
- **A ponta operacional é majoritariamente feminina** (banhistas e tosadoras) —
  comunicação de "empreendedor tech" não conversa com esse público.
- **Valorizam:** cuidado visível com o animal (foto, "ele se comportou bem"),
  simplicidade, autonomia, prova social de petshop do mesmo porte.
- **Rejeitam:** jargão corporativo, demonstração obrigatória, taxa de implantação,
  fidelidade.
- **Formato que funciona no Instagram:** antes e depois de banho e tosa, bastidores,
  transformação.

## Argumentos comparativos (seção 4)

- O líder (SimplesVet) cobra **R$ 0,50 por WhatsApp** enviado: 300 atendimentos × 2
  mensagens = R$ 300/mês só de mensagem. Na prática o petshop pequeno não liga o
  lembrete. **O nosso WhatsApp sai pelo número do próprio petshop, sem cobrança por
  mensagem.**
- O segundo colocado roda em Windows instalado, não funciona no celular e cobra
  R$ 1.000 de implantação. **Nós: navegador e app, sem taxa de implantação, importação do
  sistema anterior incluída.**
- "Os sistemas pet foram feitos para clínica veterinária e vendidos a petshop."

## Números prontos para tela

- 166,8 milhões de pets no Brasil; 62,5 mi cães e 33,3 mi gatos.
- 57,7% dos petshops são MEI; mais da metade dos pequenos negócios não usa sistema
  integrado.
- 53% das faltas são esquecimento.
- Confirmação por WhatsApp reduz faltas de 40% a 70%.
- 20% de falta em 150 atendimentos a R$ 90 = R$ 2.700/mês perdidos.
- Banho de poodle ≈ 40 min; golden retriever ≈ 1h30.

## O que **não** prometer no vídeo

- **Preço:** o relatório recomenda R$ 39–69/mês; os nossos planos são R$ 149 (Starter) e
  R$ 299 (Pro), e o WhatsApp é do Pro. Não usar "a partir de R$ 49" nem "WhatsApp em
  todos os planos".
- **No-show de 35%:** o próprio relatório pede usar 20%–25% como premissa conservadora.
- **Botão de confirmar com um toque**, **foto no "pet pronto"**, **comissão** e
  **margem por serviço**: não existem hoje.
