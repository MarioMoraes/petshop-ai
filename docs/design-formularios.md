# Padrão de formulário

Como toda tela de entrada de dados do PetShop AI é montada. Vale para cadastro, ficha e
painel de configuração — qualquer lugar onde alguém digita.

A referência viva é `frontend/src/app/(admin)/tutores/tutor-form.tsx`. Quando este documento e o
código divergirem, o código do formulário de tutor é quem está certo.

> **Onde as telas moram.** Desde o MOD-SITE, `src/app` tem **dois raízes**: `(admin)`,
> com o `ClerkProvider` e todas as telas de equipe, e `(site)`, que serve a página
> pública do petshop sem carregar identidade nenhuma. O grupo entre parênteses não vira
> segmento de URL — `(admin)/dashboard` continua sendo `/dashboard`.

As peças estão em `frontend/src/app/globals.css` (§Formulário) e
`frontend/src/components/ui.tsx`. Cada uma carrega no próprio comentário o porquê de ter
a forma que tem; aqui fica só a regra de uso.

---

## O esqueleto

```tsx
<form onSubmit={handleSubmit} className="space-y-5" noValidate>
  {/* alertas no topo, antes da primeira ficha */}

  <Card tone="soft" className="space-y-5">
    <SectionHead
      icon={<UsersIcon />}
      tone="icon-people"
      eyebrow="01 · Identificação"
      title="Quem é o tutor"
      description="Opcional — só quando a seção precisa de uma frase de contexto."
    />

    <Field label="Nome completo" htmlFor="fullName" error={fieldErrors.fullName}>
      <input id="fullName" className="field" … />
    </Field>
  </Card>

  <FormActions>
    <Link className="btn btn-ghost">Cancelar</Link>
    <button type="submit" className="btn btn-primary">Cadastrar</button>
  </FormActions>
</form>
```

---

## As nove regras

### 1. Ficha é `Card tone="soft"`. Conteúdo é `Card` branco.

`tone="soft"` dá ao cartão o gradiente cinza frio e a elevação de três camadas. Use em
cartão que **contém campos**. Cartão que contém conteúdo para ler — lista, detalhe,
painel de números, estado vazio — fica no branco padrão.

A razão é funcional, não decorativa: `.field` é branco, e campo branco em cartão branco
some. O cartão é a mesa; o campo é o papel sobre ela. Não podem ser da mesma cor.

Numa tela mista — o prontuário do pet, por exemplo — conviver os dois é **correto**: o
resumo de alertas é leitura e fica branco, as três seções editáveis ficam soft.

### 2. Toda seção abre com `SectionHead`.

Nunca um `<h2>` solto. O componente entrega três coisas de uma vez: o chip colorido que
ancora a leitura vertical, o olho-de-boi mecânico e o título.

- **Título** — o *Título 4 · Card padrão* do `design/design-modelo.html`: 1.125rem/1.75rem,
  peso 600, Inter. **Nunca serifa.** Instrument Serif existe no sistema como acento de
  display (§Título 1 · Acento serif); em tela de trabalho, quatro serifas empilhadas
  puxam a atenção que os campos precisam.
- **Olho-de-boi** — o *Eyebrow · Neutro*: 0.75rem/1rem, peso 600, tracking 0.1em.

Escreva o título como **pergunta ou afirmação humana** e deixe o rótulo técnico no
olho-de-boi: `01 · IDENTIFICAÇÃO` / "Quem é o tutor". O olho-de-boi diz o que a seção é,
o título diz o que ela quer saber.

**Todo título do sistema sai em Title Case** — "Quem É o Tutor", "Contas a Receber" —, e
quem aplica é a peça, não a tela: `PageHeader`, `SectionHead`, `CardHead`, `Modal`,
`EmptyState` e `RecordHero` passam o texto por `titleCase` (`shared-types/src/text.ts`).
Escreva o título em caixa de frase, como sempre; a peça converte. Conectivos (de, a, e,
com, para…) ficam minúsculos no meio da frase, unidades ("15 kg") também, e o resto de
cada palavra não é tocado — "PIX" e "WhatsApp" saem como estão. Um `<h1>`–`<h3>` escrito
à mão fora dessas peças precisa chamar `titleCase` ele mesmo.

**Abas e menus** seguem a mesma regra, também na peça: `Tabs` do kit, as faixas por rota
(`agenda-tabs.tsx`, `financeiro-tabs-nav.tsx`), o `NavLink`/`NavPill` do menu lateral e
do console, e o menu do Início do Portal. Filtros em pílula (contatos do site, busca de
listas) não são abas e ficam em caixa de frase. No app, o menu do Início e o título da
tela a que cada item leva são escritos já em Title Case — os dois precisam bater.

Os **PDFs** seguem a mesma regra: o molde comum (`packages/documents/src/layout.ts`) converte
o título do documento — recibo, extrato, receita, termo — no topo e no rodapé, e os
relatórios com template próprio (cobrança, fechamento do caixa, posição do estoque, cópia
dos dados do titular) convertem o título e os cabeçalhos de seção. O nome do
estabelecimento no topo sai como foi digitado.

Os **títulos dentro do texto de um termo** (`# …`) também: quem converte é o parser —
`parseTermBody` em `shared-types/src/terms.ts`, que a tela e o PDF do aceite usam, e a
tradução dele em `app/lib/src/telas/documentos/texto_do_termo.dart`, com o `titleCase`
de `app/lib/src/titulo.dart`. O texto guardado, que é o que o aceite prova, não muda. Os
dois `titleCase` são a mesma regra e têm os mesmos casos de teste: mexer num é mexer no
outro.

### 3. Um tom de ícone por formulário, repetido em todas as seções.

O tom diz o **tipo do dado**, e as seções de uma mesma ficha são o mesmo tipo. Uma cor
por seção vira confete e sugere domínios que não existem. Com o tom repetido, os chips
formam uma coluna que dá espinha à tela, e a diferença fica por conta do desenho do
ícone — que é o que de fato muda de uma seção para a outra.

O tom é o do domínio no menu lateral (`app-shell.tsx`):

| Domínio | Tom |
|---|---|
| Tutores | `icon-people` |
| Pets, prontuário | `icon-pet` |
| Agenda, Taxi Dog | `icon-time` |
| Mensagens | `icon-brand` |
| Financeiro | `icon-money` |
| Estoque | `icon-money` |
| Equipe | `icon-people` |
| Configurações | `icon-system` |

### 4. Numere as seções quando forem uma sequência; não numere quando forem abas.

Cadastro é percorrido de cima a baixo: `01 · Identificação`, `02 · Endereço`. Painel de
configuração em abas não tem ordem — o olho-de-boi vira o nome do domínio
(`Relacionamento`, `Taxi Dog`, `Configurações`).

### 5. Nenhum controle nativo sem estilo.

| Controle | Peça |
|---|---|
| Caixa de seleção com rótulo longo | `<Choice>` |
| Caixa de seleção dentro de uma linha que já é uma peça | só o átomo `className="check"` |
| Duas ou três opções exclusivas | `<Segmented>` |
| Escolha exclusiva numa lista de linhas | `.option` + `.check .check-radio` |
| Campo | `className="field"` |
| Campo com glifo | `.field-wrap` + `.field-lead` |
| Campo numa fila de ações, ao lado de botões | `.field` + `.field-inline` |
| Botão | `<Button>` |
| Link com cara de botão | `<ButtonLink>` (`components/links.tsx`) |
| Atalho para outra tela, sem peça | `<ButtonLink variant="link">` |

`.check-radio` é `.check` com o raio redondo e um ponto no lugar do tique: mesma caixa,
mesma sombra, mesmo foco. O par "escolha uma" / "marque quantas quiser" passa a ser lido
pela **forma**, que é a convenção que todo mundo já conhece.

`.field-inline` é a mesma peça em outra proporção: largura do conteúdo e a altura de
`.btn h-9`, para o seletor que mora numa linha `flex` com botões. Não é um campo
menor — é o mesmo campo com a caixa que a fila comporta. Fora de uma fila, use
`.field` puro e deixe ele ocupar a largura.

`<button className="btn btn-primary">` não existe mais em `src/app`, e
`src/lib/botoes.test.ts` é o que faz o esquecimento aparecer. O que a peça acrescenta à
classe é a **espera**, e ela tem dois lados que não se confundem:

- **`busy`** é *"você já clicou"*. Trava o botão, gira o anel e troca o rótulo por
  `busyLabel`. Vai no botão que dispara a ação.
- **`disabled`** é *"não dá para clicar agora"*. Apaga a peça para 45% e dessatura. Vai
  no **Cancelar** ao lado de um Salvar que está no ar — quem está trabalhando é o
  vizinho, e dar o relógio aos dois é dizer que os dois foram clicados.

**`busyLabel` não é enfeite.** Sob `prefers-reduced-motion` o anel se esconde, e sem o
rótulo quem pediu menos movimento clica em Salvar e não vê nada mudar — que é
exatamente o defeito de onde a peça partiu. Escreva-o em todo botão que grava ou que
espera uma resposta do servidor; o Cancelar e a paginação puramente local dispensam.

**Botão é escuro.** A variante padrão (`primary`) vale para toda ação do Admin: a do
topo da tela, no `actions` do `PageHeader`, e as de dentro dela — Editar, Adicionar,
Filtrar, paginação, Baixar PDF, Tornar capa. Não se passa `variant` para dizer "esta é
menos importante".

**`ghost` tem um uso só: desistir ao lado da ação que grava.** Cancelar, Voltar, Fechar,
Agora não, Manter o horário — no rodapé do `<Modal>`, no `<FormActions>` e na linha de
confirmação dentro de um cartão. Ali o fantasma é o que deixa ver, sem ler, qual dos dois
encerra o caso; dois escuros lado a lado empatam. Pela mesma razão:

- o **Fechar sozinho**, sem ação ao lado, é escuro — não há de quem se distinguir;
- o botão que **alterna** entre abrir e desistir troca de variante com o estado:
  `variant={open ? 'ghost' : 'primary'}` para "Registrar alergia" ↔ "Cancelar";
- o **Pular por enquanto** do onboarding é desistência ao lado de Salvar, e fica fantasma.

**Destrutivo não leva `text-danger` no botão.** Vermelho sobre o grafite do `primary`
não se lê. Excluir, Remover, Anonimizar e Descartar são escuros com texto branco; o aviso
de perigo mora na confirmação que eles abrem, e é lá que `text-danger` e `<Alert
tone="danger">` continuam. O link sublinhado vermelho no pé do corpo (regra 8) segue
valendo — ele não é `.btn`.

**A exceção é a fila de filtros.** Onde o botão marca a opção escolhida (`active`, como
em Contatos do site), o escolhido é escuro e os outros são fantasma: ali a variante é o
próprio estado, e pintar todos de escuro apagaria a seleção.

**`variant="link"` é texto sublinhado, e não uma terceira força de botão.** Vale para o
atalho que só **muda de tela** num cabeçalho que não tem ação própria — as Fotos e os
Contatos em `/site`, onde a ação de verdade (Salvar, Publicar) mora no formulário
abaixo. Duas pílulas escuras ali disputavam o olho com o que a tela realmente pede. Não
é o substituto do `ghost`: desistir continua sendo fantasma ao lado de quem grava.

A regra é do Admin. O Portal tem peça própria desenhada para o celular, e o console da
plataforma não entrou na troca.

`Choice` embrulha a caixa numa linha inteira clicável — num balcão ninguém mira 20px.
Use o átomo `.check` sozinho quando a linha **já** é um alvo com outra coisa dentro
(o dia da semana com os horários ao lado), para não criar alvo dentro de alvo.

### 6. O acento aparece uma vez, e pequeno.

A cor de marca fica nos 20px da caixa marcada e no anel de foco. **Nunca** como fundo de
área grande: o coral é vizinho do vermelho de perigo, e em área grande ele alarma.

Estado ativo no sistema é **levante branco**, não pressão cinza — a mesma linguagem do
`.nav-item-active` e do polegar do `.segment`.

### 7. Alerta é `<Alert>`, nunca retângulo colorido.

`tone="danger"` para o que bloqueia, `tone="accent"` para o que avisa. Aviso que **não**
impede salvar leva `role="status"`: interromper o leitor de tela para dizer "pode seguir
assim" é o uso que treina o usuário a ignorar avisos.

### 8. Formulário que precisa de foco exclusivo é `<Modal>`.

`components/modal.tsx`. Vale quando o formulário responde a uma linha de uma lista — o
check-out de um atendimento, o pedido de leva-e-traz — e não a uma página inteira.
Antes dele, esses formulários abriam dentro do cartão que os originou, na largura de
uma coluna.

O diálogo tem três faixas: **cabeçalho** (chip do domínio, olho-de-boi, título e a
linha de contexto), **corpo rolável** com o papel de `.card-soft`, e **rodapé** de
ações. As duas pontas não rolam, e a razão é funcional: o cabeçalho é o que diz de qual
registro se trata, e vê-lo sumir enquanto se digita é como se preenche a ficha errada.

Regras de uso:

- **Um tom de ícone por diálogo**, o do domínio — a mesma regra 3.
- **Duas ações no rodapé**, no máximo, e uma delas é a principal. A terceira faz a barra
  quebrar em duas linhas e joga o botão que encerra o caso para baixo.
- **Ação destrutiva não vai no rodapé.** Ela desce para o pé do corpo, como texto
  sublinhado — alcançável, e não a um deslize do polegar da ação principal.
- **`busy` enquanto a ação está no ar.** Nem `Escape` nem o clique no véu fecham: uma
  gravação interrompida no meio deixa o usuário sem saber se vingou.
- Abaixo de `sm` ele vira **folha inferior**, colada no rodapé, e os botões empilham na
  largura inteira.

### 9. A barra de ação é `<FormActions>` — mas só no formulário de página inteira.

Ela é `position: sticky`, então precisa que a página role. Painel com salvamento próprio
por aba mantém a linha de botões dentro do cartão: barra grudada dentro de um cartão
gruda no cartão, não na tela.

---

## Telas de leitura: listagem e ficha

Não são formulário, mas usam as mesmas peças.

- **Listagem de cadastro** (`/pets`, `/tutores`) é `components/record-list.tsx` +
  `components/list-search.tsx`: busca com lupa e o "limpar", fila de pílulas de filtro
  com "Todos" na frente, e grade de cartões brancos com rosto, meta e um pé separado por
  fio. Cadastro novo com listagem usa as mesmas peças.
- **Ficha do registro** (`/tutores/[id]`, `/pets/[id]`) abre com `<RecordHero>`
  (`components/record-hero.tsx`): o rosto grande, o nome, os selos, a ação Editar e uma
  **faixa de três ou quatro números** — o que se procura ao abrir a ficha (saldo, último
  atendimento, peso). Número que sobe para o herói sai da aba, para não repetir.
- **Aba Dados** agrupa as linhas rótulo/valor por assunto em `<DataGroup>`, numa grade
  de duas colunas — nunca uma coluna só de dez `DataRow`.
- **`<Tabs>` é trilho com pastilha branca**, como o `Segmented`, e rola na horizontal em
  vez de quebrar. O número vai em `count`, e não no texto do rótulo ("Pets (3)").
- **Cartão de leitura abre com `<CardHead>`** (`components/ui.tsx`): chip pequeno no
  tom do domínio, título em Título 4 e um slot `action` à direita. É o `SectionHead`
  sem olho-de-boi — nunca um `<h3 className="font-semibold">` solto. A exceção são as
  **confirmações de perigo** (anonimizar, excluir, registrar óbito): ali o título em
  `text-danger` é o próprio aviso, e um chip colorido o amaciaria.
- **Estado vazio tem rosto.** `<EmptyState>` recebe `icon` e `tone`: o ícone e o tom da
  área quando está vazio de verdade, `AlertTriangleIcon` sem tom quando o serviço não
  respondeu, `ShieldCheckIcon` com `icon-system` quando falta acesso — um erro com o
  mesmo rosto do "ainda não há nada" confundiria os dois. Nas telas do Admin o ícone é
  obrigatório, e `src/lib/estados-vazios.test.ts` cobra.

---

## Contraste

`--color-subtle` é **#686a6f** no `:root`, e vale para o app inteiro: `.hint`,
`.section-eyebrow`, o placeholder, o subtítulo do `PageHeader` e todo `text-subtle`.

Era #86888d, que rendia 3,55:1 sobre branco e 3,03:1 sobre a lateral — reprovava o AA da
WCAG (4,5:1) em toda tela. Por um tempo só a ficha tinha a correção (#6b6d72 no escopo de
`.card-soft` e do corpo do diálogo), mas esse valor ainda caía para 4,42:1 sobre
`--color-canvas`. #686a6f é o primeiro degrau que passa sobre **todos** os fundos: branco
5,41 · surface 4,96 · canvas 4,62 · pé da ficha 4,74 · chip 5,05.

**Não redefina `--color-subtle` num escopo.** O valor global já passa em todo fundo do
sistema; uma cópia local só serve para os dois divergirem. Fundo novo mais escuro que
`--color-canvas` pede recalcular o contraste antes de usar `.hint` sobre ele.

---

## Retorno e tabela

- **Gravou, avisa.** `useToast()` (`components/toast.tsx`, montado no layout raiz do
  Admin) mostra a pílula escura no pé da tela por três segundos. Ele sobrevive à troca de
  rota, então o formulário que grava e navega chama `toast(...)` antes do `router.push`.
  Frase curta no particípio: "Tutor cadastrado.", "Pagamento registrado.". Vale para o
  que deu certo; **erro continua no `<Alert>`/`<FormError>`** ao lado do campo — erro que
  some sozinho não se lê até o fim.
- **Tabela de números é `.data-table`** (dentro de `card overflow-x-auto p-0`, ou
  `.data-table-flush` quando o cartão já tem padding). A célula só diz o que é dela:
  `text-right tabular-nums` no número, `font-medium` no que identifica a linha. Nada de
  `px-4 py-3` nem `border-b` por célula — a grade é da peça.

---

## O que já foi tentado e recusado

Está aqui para não voltar:

| Tentativa | Por que caiu |
|---|---|
| Título de seção em Instrument Serif 24px | Recusado. Serifa é acento de display; em tela de trabalho puxa a atenção dos campos. |
| Ficha em off-white morno (#fbfaf7) | Claro demais — quase não se distinguia do branco. |
| Ficha em creme (#f7f4ea) | Recusado. Dava ao formulário um material próprio, estranho num app de neutros frios. |
| Linha marcada com véu escuro | Virava a coisa mais pesada da tela para dizer algo menos importante que qualquer campo. |
| Linha marcada tingida com 7% do acento | Duas linhas ligadas liam como erro. |
| `--color-chip` como superfície rebaixada | Hex fixo só funciona sobre um fundo; sobre a ficha o estado sumia. Use véu de opacidade. |
| Sombra de uma camada só | Produz mancha, não altura. Blur curto deixa a peça baixa; blur longo tira a aresta. |
| Painel de formulário aberto dentro do cartão da lista | Espremido na largura de uma coluna, e empurrava o resto da lista para baixo. Virou `<Modal>`. |
| Três botões no rodapé do diálogo | Quebrava em duas linhas e a ação principal ia para a segunda. |
| Ação destrutiva ao lado da principal no rodapé | Alvo vizinho do botão mais clicado da janela. |
| Botão fantasma como ação secundária (Mural ao lado de Marcar horário, os atalhos do topo, Editar e Excluir no detalhe) | Recusado. A ação lia como desabilitada; toda ação é escuro, e o fantasma ficou só para desistir. |
| Botão destrutivo com texto vermelho sobre o escuro | Vermelho sobre grafite não se lê. O aviso vai na confirmação. |

---

## Onde o padrão já está aplicado

| Tela | Arquivo |
|---|---|
| Cadastro/edição de tutor | `app/(admin)/tutores/tutor-form.tsx` |
| Cadastro/edição de pet | `app/(admin)/pets/pet-form.tsx` |
| Prontuário de segurança | `app/(admin)/pets/[id]/safety-record.tsx` |
| Configurações do estabelecimento | `app/(admin)/configuracoes/settings-form.tsx` |
| Configurações de relacionamento | `app/(admin)/crm/configuracoes/settings-form.tsx` |
| Configurações do Taxi Dog | `app/(admin)/taxi/configuracoes/settings-form.tsx` |
| Configurações de cobrança | `app/(admin)/financeiro/configuracoes/billing-settings-form.tsx` |
| Cadastro de produto, entrada e ajuste de estoque | `app/(admin)/estoque/product-form.tsx`, `estoque/[id]/stock-panel.tsx` |
| Site do estabelecimento | `app/(admin)/site/site-form.tsx` |
| Ficha e check-out do atendimento | `app/(admin)/agenda/dia/appointment-dialog.tsx` |
| Remoção de membro da equipe (só o diálogo) | `app/(admin)/equipe/team-manager.tsx` |

Ainda **não** aplicado, por serem telas de lista com formulário embutido — o cartão
branco de conteúdo continua correto nelas, e forçar seção numerada seria errado:
`agenda/servicos`, `agenda/profissionais`, `financeiro/pacotes`, `equipe`,
`taxi/configuracoes` (frota e zonas), `configuracoes/breed-catalog`. O que **é** da
regra 8 nelas entra como diálogo, e não como painel dentro do cartão: a confirmação de
remover alguém da equipe é o primeiro caso. As caixas de seleção
delas **já** receberam o átomo `.check`.

O onboarding (`app/(admin)/onboarding/steps/*`) roda fora do `AppShell`, com moldura própria, e
foi deixado de lado de propósito.
