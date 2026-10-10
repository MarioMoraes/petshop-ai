---
format: 1080x1920
duration: 47.5s
message: "O PetShop AI põe o petshop inteiro num lugar só — da agenda ao estoque"
arc: Gancho → 8 recursos → Fecho com CTA
audience: donos e gerentes de petshop e banho e tosa
mode: collaborative
---

## Locked

- Folha v1 aprovada em 2026-10-10. Construído em `index.html` (composição única, 10 cenas). Duração final 47,5 s: o fecho ganhou 0,5 s para o CTA ser lido.
- Trilha: `scripts/trilha.mjs` (a do reel anterior a 120 BPM, para todo corte cair num tempo), gerada em `assets/trilha.wav` por `scripts/gerar-trilha.mjs`.

## Frame 1 — Gancho

- scene: oito ícones coloridos voam de fora e orbitam um núcleo; colapsam no título
- duration: 3.5s
- transition_in: cut
- status: animated
- src: compositions/01-gancho.html
- blueprint: constellation-hub

"O Petshop Inteiro / *num lugar só*". Os oito chips (um por recurso, no tom do domínio)
entram em anel, giram meia volta e são sugados para o centro no corte.

## Frame 2 — Agendamento por WhatsApp, Site ou App

- scene: três canais soltam cartões que voam e encaixam numa grade de agenda; contador sobe
- duration: 5s
- transition_in: whip
- status: animated
- src: compositions/02-agenda.html
- blueprint: grid-card-assemble

Topo: "Agenda Cheia / *do jeito do cliente*". Três pílulas (WhatsApp verde, Site,
App) emitem cartões — "Thor · Banho 09:00", "Luna · Tosa 10:30" — que pousam na grade do
dia. Contador "Agendamentos hoje" conta 0 → 23.

## Frame 3 — Atendimento com IA no WhatsApp

- scene: celular com conversa tutor × agente; proposta vira "Confirmado"
- duration: 6s
- transition_in: push
- status: animated
- src: compositions/03-ia.html
- blueprint: agent-progress-theater

"Atende Sozinho / *24 horas*". Tutor: "Tem horário sábado pro Thor?" → "digitando…" →
agente oferece 09:00 / 10:30 / 14:00 → tutor "10:30" → cartão de proposta → "Sim" →
selo verde "Agendado". Chip lateral: "Entende áudio também".

## Frame 4 — Pets: Prontuário, Vacinas e Histórico

- scene: ficha do pet com abas que trocam; carteira de vacinação preenche doses
- duration: 5.5s
- transition_in: crossfade
- status: animated
- src: compositions/04-pets.html
- blueprint: grid-card-assemble + kinetic-type-beats

"Cada Pet / *com a sua história*". Cartão "Thor · Golden · 4 anos". Aba Prontuário (alerta
"Alérgico a dipirona" em rosa) → aba Vacinas (V10, Antirrábica, Giárdia com bolinhas de dose
enchendo; lembrete "Próxima dose em 12 dias · tutor avisado") → aba Histórico (linha do
tempo de banhos e consultas descendo).

## Frame 5 — Controle de Caixa

- scene: a gaveta do dia — movimentos entram e o esperado soma sozinho
- duration: 4.5s
- transition_in: cut
- status: animated
- src: compositions/05-caixa.html
- blueprint: dataviz-countup

"Caixa do Dia / *conferido em segundos*". Abertura R$ 200,00; linhas Pix, Cartão,
Dinheiro, Sangria entram uma a uma; "Esperado" conta até R$ 1.847,50; carimbo
"Fechado · sem diferença" em verde.

## Frame 6 — Fluxo de Caixa

- scene: gráfico de barras entradas×saídas cresce, linha do saldo se desenha
- duration: 4.5s
- transition_in: crossfade
- status: animated
- src: compositions/06-fluxo.html
- blueprint: dataviz-countup

"Fluxo de Caixa / *sem planilha*". Barras verdes (entradas) e cinza (saídas) por semana
sobem em cascata; linha do saldo se desenha por cima; KPI "Saldo do mês +R$ 12.480" conta.

## Frame 7 — Controle de Estoque

- scene: barras de nível descem conforme vendas; uma bate no mínimo e acende alerta
- duration: 4.5s
- transition_in: cut
- status: animated
- src: compositions/07-estoque.html
- blueprint: grid-card-assemble

"Estoque / *que avisa antes*". Lista: Shampoo Neutro, Ração Premium 15kg,
Vacina V10, Laço. Cada venda/atendimento ("−1") baixa a barra; Shampoo cruza o mínimo →
fica vermelho e cai o aviso "Repor: Shampoo Neutro · 2 un." (sino).

## Frame 8 — Site Próprio do Petshop

- scene: janela de navegador monta a página pública do petshop e rola
- duration: 4.5s
- transition_in: whip
- status: animated
- src: compositions/08-site.html
- blueprint: device-surface-showcase

"Seu Site / *pronto no ar*". Barra de endereço digita "seupetshop.com.br"; hero, serviços
com preço, horários e botão "Agendar Online" pulsando.

## Frame 9 — Site do Tutor

- scene: celular do tutor no Portal — Meus Pets, saldo e Pagar com PIX
- duration: 4.5s
- transition_in: push
- status: animated
- src: compositions/09-portal.html
- blueprint: device-surface-showcase

"Área do Tutor / *tudo na palma da mão*". Telas trocam: Meus Pets (cartões), Carteira de
Vacinas, Saldo R$ 180,00 → "Pagar Agora" → QR PIX → "Pago ✓".

## Frame 10 — Fecho

- scene: os oito chips voltam em grade e assentam sob a marca; CTA
- duration: 5s
- transition_in: crossfade
- status: animated
- src: compositions/10-fecho.html
- blueprint: logo-assemble-lockup

"Você cuida do pet. / *A gente cuida do resto.*" → marca PetShop AI → "Teste Grátis por 14 Dias", petshop.officestecnologia.com.br. Barra dourada de progresso completa.
