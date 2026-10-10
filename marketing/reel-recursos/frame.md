---
name: PetShop AI — Reel de Recursos
canvas: 1080x1920
colors:
  background: "#141416"
  background-raised: "#1d1e22"
  foreground: "#ffffff"
  accent: "#f05a3c"
  accent-deep: "#c93a24"
  gold: "#f2d27a"
  gold-deep: "#b8862f"
  ink: "#232427"
  ink-strong: "#171719"
  muted: "#5d6068"
  subtle: "#7d8089"
  card: "#ffffff"
  card-soft: "#f1f3f6"
  whatsapp-header: "#0b6b57"
  whatsapp-wallpaper: "#efe7dd"
  whatsapp-out-bubble: "#d9fdd3"
  # um tom por recurso: forte (sobre branco) / claro (brilho sobre escuro)
  tone-time: ["#4369b5", "#86a9f0"]      # agenda
  tone-system: ["#5457c4", "#9a9cf4"]    # IA
  tone-pet: ["#966700", "#e9b04a"]       # pets
  tone-health: ["#a94d79", "#ea86b5"]    # vacinas, saúde
  tone-money: ["#22864a", "#5ccb88"]     # caixa, fluxo
  tone-metric: ["#00818c", "#4cc9d4"]    # site, gráficos
  tone-brand: ["#b0503e", "#f28a73"]     # estoque, marca
  tone-people: ["#7e5db1", "#b39cf0"]    # tutor
  tone-danger: ["#c2412c", "#ff8a73"]    # alerta
typography:
  display: { family: Inter, weight: 600, size: 104px, tracking: -0.04em, line-height: 1.0 }
  display-accent: { family: Instrument Serif, style: italic, weight: 400, size: 1.1em, color: accent }
  body: { family: Inter, weight: 500-600, size: 24-34px }
  label: { family: Inter, weight: 500, size: 22-24px, color: subtle }
  numbers: { family: Inter, weight: 700, feature: tabular-nums }
  fonts-dir: fonts/ (Inter Regular/Medium/SemiBold/Bold, InstrumentSerif-Italic)
spacing:
  side-gutter: 60-70px
  safe-zone-y: [250, 1550]
components:
  card: { radius: 40px, background: card, shadow: "0 60px 120px -40px rgb(0 0 0 / .85)" }
  float: { radius: 30px, background: card, chip: 64px }
  chip: { radius: 18px, light: tone-soft + tone-ring, dark: 20% tone glow }
  kicker: { pill, glass rgb(255 255 255 / .07), number in tone, chip 48px }
  phone: { 600x1000, radius 84px, bezel gradient #2c2d31→#0f0f11 }
  progress: { height 12px, bottom, gold gradient, 0→100% linear over the whole reel }
---

## Overview

Reel vertical do PetShop AI (Offices Aplicativos): fundo escuro, cartões brancos de
interface que imitam o produto e um tom de cor por recurso, como o menu lateral do Admin.
Vende o resultado (agenda cheia, caixa conferido), não a tecnologia.

## The Frame

- Cabeçalho fixo no topo de cada cena (y≈250): selo-pílula "NN · Recurso" com chip no tom,
  título Inter 600 em Title Case e segunda linha em Instrument Serif itálico laranja,
  terminando em ponto.
- Abaixo (y≈650–1500): a peça de UI que demonstra o recurso — cartão branco, celular ou
  navegador — com um "flutuante" branco que pousa por cima dela no clímax da cena.
- Fundo único para o vídeo inteiro: brilho radial que troca de cor para o tom da cena,
  um segundo brilho azul fixo, pontilhado e patinhas a 7% subindo devagar.
- Barra dourada de progresso na base, sempre.

## Motion

- Cada cena tem **uma ação que acontece** (o cartão voa do canal para a agenda, a conversa
  se escreve, a dose enche, o total soma, a barra cruza o mínimo). Nunca slide parado.
- Cabeçalho: selo com back.out, linha 1 sobe (power3.out), linha em serifa se revela
  da esquerda (clip-path).
- Contadores por função do tempo local num tween só (seguro em qualquer seek).
- Costuras: corte seco, empurrão para cima, dissolve com zoom, cruzado, chicote para a
  esquerda. O que sai vai para cima ou para a esquerda. Cortes em múltiplos de 0,5 s,
  na batida da trilha a 120 BPM.
- Abertura: oito ícones em órbita sugados para a pata. Fecho: os oito voltam em fila
  sob o slogan "Você cuida do pet. / A gente cuida do resto." e o CTA com brilho.

## Do

- Nenhum ícone sem cor; títulos e botões em Title Case.
- Texto só entre y 250 e 1550 (interface do Reels).
- Números e nomes de exemplo verossímeis, em pt-BR (R$ 1.847,50, "Thor · Banho").

## Don't

- Gradiente linear de tela inteira (banding no H.264).
- Movimento decorativo sem sentido; cena que é só um cartão parado.
- Prometer o que o produto não faz.

## Reference implementation

`marketing/reel-recursos/` no repositório petshop: `index.html` (as 10 cenas e a
timeline), `reel.css` (tokens e peças), `storyboard.html` (folha de rascunhos),
`scripts/trilha.mjs` + `scripts/gerar-trilha.mjs` (trilha sintetizada; os cortes saem da
lista de inícios das cenas). Um novo reel copia esse projeto e troca cenas e textos.
