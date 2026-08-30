# PetShop AI

## Frontend — telas de entrada de dados

Ao criar ou alterar **qualquer formulário** (cadastro, ficha, painel de configuração),
leia antes [`docs/design-formularios.md`](docs/design-formularios.md) e siga o padrão.

O resumo que mais importa:

- ficha com campos é `Card tone="soft"`; cartão de conteúdo (lista, detalhe, números)
  continua branco;
- toda seção abre com `<SectionHead>`, nunca um `<h2>` solto — título no *Título 4*
  (Inter 18px/600), **nunca serifa**;
- um tom de ícone por formulário, o do domínio no menu lateral, repetido em todas as
  seções;
- nenhum controle nativo sem estilo: `<Choice>`, `<Segmented>`, `.check`, `.field`;
- alerta é `<Alert>`; barra de ação de formulário de página inteira é `<FormActions>`.

O documento traz também a tabela do **que já foi tentado e recusado** — vale conferir
antes de propor uma alternativa visual.

A referência viva é `frontend/src/app/tutores/tutor-form.tsx`.
