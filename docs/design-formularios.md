# Padrão de formulário

Como toda tela de entrada de dados do PetShop AI é montada. Vale para cadastro, ficha e
painel de configuração — qualquer lugar onde alguém digita.

A referência viva é `frontend/src/app/tutores/tutor-form.tsx`. Quando este documento e o
código divergirem, o código do formulário de tutor é quem está certo.

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

## As oito regras

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
| Campo | `className="field"` |
| Campo com glifo | `.field-wrap` + `.field-lead` |

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

### 8. A barra de ação é `<FormActions>` — mas só no formulário de página inteira.

Ela é `position: sticky`, então precisa que a página role. Painel com salvamento próprio
por aba mantém a linha de botões dentro do cartão: barra grudada dentro de um cartão
gruda no cartão, não na tela.

---

## Contraste

`--color-subtle` (#86888d) rende **3,55:1 sobre branco** e reprova o AA da WCAG, que pede
4,5:1 para texto normal. Isso vale para `.hint`, `.section-eyebrow`, o subtítulo do
`PageHeader` e todo `text-subtle` — **em todo o app, desde antes deste padrão.**

`.card-soft` redefine `--color-subtle: #6b6d72` no próprio escopo, o que põe o texto
auxiliar dos formulários em 4,71:1 sem tocar nas telas que não são formulário.

**O débito no `:root` continua aberto.** Ao mexer em texto secundário fora de formulário,
lembre que ele reprova.

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

---

## Onde o padrão já está aplicado

| Tela | Arquivo |
|---|---|
| Cadastro/edição de tutor | `app/tutores/tutor-form.tsx` |
| Cadastro/edição de pet | `app/pets/pet-form.tsx` |
| Prontuário de segurança | `app/pets/[id]/safety-record.tsx` |
| Configurações do estabelecimento | `app/configuracoes/settings-form.tsx` |
| Configurações de relacionamento | `app/crm/configuracoes/settings-form.tsx` |
| Configurações do Taxi Dog | `app/taxi/configuracoes/settings-form.tsx` |
| Configurações de cobrança | `app/financeiro/configuracoes/billing-settings-form.tsx` |

Ainda **não** aplicado, por serem telas de lista com formulário embutido — o cartão
branco de conteúdo continua correto nelas, e forçar seção numerada seria errado:
`agenda/servicos`, `agenda/profissionais`, `financeiro/pacotes`, `equipe`,
`taxi/configuracoes` (frota e zonas), `configuracoes/breed-catalog`. As caixas de seleção
delas **já** receberam o átomo `.check`.

O onboarding (`app/onboarding/steps/*`) roda fora do `AppShell`, com moldura própria, e
foi deixado de lado de propósito.
