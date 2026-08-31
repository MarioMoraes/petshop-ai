/**
 * Ícones do sistema.
 *
 * Traçados do Lucide, o mesmo conjunto que `design/design-modelo.html` usa, inline em
 * vez de vindos de pacote: são poucos, e uma dependência de biblioteca de ícones
 * inteira para isso pesaria mais que o benefício. `stroke-width: 1.5` é o do design.
 */

const BASE = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

/**
 * Tom do ícone — a família de cor do tipo que ele representa (`globals.css`, §Tom do
 * ícone). Os traços continuam em `currentColor`: quem pinta é quem embrulha, com
 * `.icon-chip` no cartão ou `.icon-tint` no menu. É o que mantém o mesmo ícone
 * utilizável nos dois lugares sem duas versões dele.
 *
 * O tom é intrínseco ao ícone e não à tela: o calendário é azul na Agenda, no painel e
 * onde mais aparecer. Cada função abaixo declara o seu logo acima, e é dali que o valor
 * deve ser copiado para o `className` — não do fundo do arquivo, para não divergirem.
 */
export type IconTone =
  | 'icon-brand'
  | 'icon-people'
  | 'icon-pet'
  | 'icon-time'
  | 'icon-money'
  | 'icon-metric'
  | 'icon-health'
  | 'icon-system'

/** Tom: `icon-people`. */
export function UsersIcon() {
  return (
    <svg {...BASE}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

/**
 * Crachá — a equipe. Tom: `icon-people`.
 *
 * Não é o `UsersIcon` de novo porque no menu ele já é Tutores, e dois itens com o
 * mesmo desenho obrigariam a ler o rótulo para distinguir o que o ícone existe para
 * distinguir sozinho.
 */
export function IdCardIcon() {
  return (
    <svg {...BASE}>
      <path d="M16 10h2" />
      <path d="M16 14h2" />
      <path d="M6.17 15a3 3 0 0 1 5.66 0" />
      <circle cx="9" cy="11" r="2" />
      <rect x="2" y="5" width="20" height="14" rx="2" />
    </svg>
  )
}

/** Tom: `icon-pet`. */
export function PawPrintIcon() {
  return (
    <svg {...BASE}>
      <circle cx="11" cy="4" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="20" cy="16" r="2" />
      <path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z" />
    </svg>
  )
}

/** Tom: `icon-brand`. */
export function HomeIcon() {
  return (
    <svg {...BASE}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  )
}

/** Tom: `icon-system`. */
export function SettingsIcon() {
  return (
    <svg {...BASE}>
      <path d="M12.9 3h-1.8a1.6 1.6 0 0 0-1.6 1.4l-.1.9a7 7 0 0 0-1.3.8l-.9-.4a1.6 1.6 0 0 0-2 .7l-.9 1.5a1.6 1.6 0 0 0 .4 2l.7.6a7 7 0 0 0 0 1.5l-.7.6a1.6 1.6 0 0 0-.4 2l.9 1.5a1.6 1.6 0 0 0 2 .7l.9-.4q.6.5 1.3.8l.1.9a1.6 1.6 0 0 0 1.6 1.4h1.8a1.6 1.6 0 0 0 1.6-1.4l.1-.9a7 7 0 0 0 1.3-.8l.9.4a1.6 1.6 0 0 0 2-.7l.9-1.5a1.6 1.6 0 0 0-.4-2l-.7-.6a7 7 0 0 0 0-1.5l.7-.6a1.6 1.6 0 0 0 .4-2l-.9-1.5a1.6 1.6 0 0 0-2-.7l-.9.4a7 7 0 0 0-1.3-.8l-.1-.9A1.6 1.6 0 0 0 12.9 3" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}

/** Tom: `icon-metric`. */
export function TrendingUpIcon() {
  return (
    <svg {...BASE}>
      <path d="m22 7-8.5 8.5-5-5L2 17" />
      <path d="M16 7h6v6" />
    </svg>
  )
}

/** Tom: `icon-time`. */
export function CalendarIcon() {
  return (
    <svg {...BASE}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  )
}

/*
 * ─── Espécies ───────────────────────────────────────────────────────────────
 *
 * Todos com tom `icon-pet`: a espécie diz **o que** é o animal, não o quanto ele
 * importa, então variar a cor por espécie criaria uma hierarquia que não existe — e
 * um semáforo de cores numa lista de trinta pets vira ruído.
 *
 * São os traçados do Lucide (`dog`, `cat`, `bird`, `rat`, `turtle`), o mesmo conjunto
 * do resto do arquivo. Desenhá-los à mão daria ícones que não conversam com o
 * calendário e a carteira ao lado.
 */

/** Tom: `icon-pet`. */
export function DogIcon() {
  return (
    <svg {...BASE}>
      <path d="M11.25 16.25h1.5L12 17z" />
      <path d="M16 14v.5" />
      <path d="M4.42 11.247A13.152 13.152 0 0 0 4 14.556C4 18.728 7.582 21 12 21s8-2.272 8-6.444a11.702 11.702 0 0 0-.493-3.309" />
      <path d="M8 14v.5" />
      <path d="M8.5 8.5c-.384 1.05-1.083 2.028-2.344 2.5-1.931.722-3.576-.297-3.656-1-.113-.994 1.177-6.53 4-7 1.923-.321 3.651.845 3.651 2.235A7.497 7.497 0 0 1 14 5.277c0-1.39 1.844-2.598 3.767-2.277 2.823.47 4.113 6.006 4 7-.08.703-1.725 1.722-3.656 1-1.261-.472-1.96-1.45-2.344-2.5" />
    </svg>
  )
}

/** Tom: `icon-pet`. */
export function CatIcon() {
  return (
    <svg {...BASE}>
      <path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-.42 7 .57 1.07 1 2.24 1 3.44C21 17.9 16.97 21 12 21s-9-3-9-7.56c0-1.25.5-2.4 1-3.44 0 0-1.89-6.42-.5-7 1.39-.58 4.72.23 6.5 2.23A9.04 9.04 0 0 1 12 5" />
      <path d="M8 14v.5" />
      <path d="M16 14v.5" />
      <path d="M11.25 16.25h1.5L12 17z" />
    </svg>
  )
}

/** Tom: `icon-pet`. */
export function BirdIcon() {
  return (
    <svg {...BASE}>
      <path d="M16 7h.01" />
      <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20" />
      <path d="m20 7 2 .5-2 .5" />
      <path d="M10 18v3" />
      <path d="M14 17.75V21" />
      <path d="M7 18a6 6 0 0 0 3.84-10.61" />
    </svg>
  )
}

/**
 * Tom: `icon-pet`.
 *
 * Desenhado à mão, e não o `rat` do Lucide: aquele é o roedor de corpo inteiro, de
 * perfil, e num círculo de 48px vira um rabisco que ninguém identifica. Aqui é uma
 * cabeça, como o cão e o gato ao lado — os três precisam ser lidos de relance numa
 * lista, e a coerência entre eles vale mais que a fidelidade ao conjunto de origem.
 */
export function RodentIcon() {
  return (
    <svg {...BASE}>
      <circle cx="6.6" cy="7.4" r="2.6" />
      <circle cx="17.4" cy="7.4" r="2.6" />
      <path d="M12 20c-4.42 0-8-2.69-8-6s3.58-6 8-6 8 2.69 8 6-3.58 6-8 6Z" />
      <path d="M9 14v.5" />
      <path d="M15 14v.5" />
      <path d="M11.25 16.4h1.5L12 17.1z" />
    </svg>
  )
}

/**
 * Tom: `icon-pet`.
 *
 * A tartaruga de perfil, à mão. Duas tentativas ficaram pelo caminho e o motivo é o
 * mesmo nas duas: **detalhe não sobrevive a 24 pixels**. O `turtle` do Lucide tem o
 * casco ocupando quase toda a caixa e vira mancha; a versão vista de cima, com quatro
 * patas curtas em volta de um oval, lê como uma flor.
 *
 * O que funciona é o menor número de formas grandes: a cúpula do casco, a linha do
 * chão, a cabeça redonda saindo à direita e duas patas. A silhueta se resolve antes
 * de o olho procurar detalhe.
 */
export function ReptileIcon() {
  return (
    <svg {...BASE}>
      <path d="M3.5 16.5a7.5 7.5 0 0 1 15 0" />
      <path d="M3.5 16.5h15" />
      <path d="M11 9v7.5" />
      <circle cx="20.7" cy="13.6" r="1.8" />
      <path d="m18.3 15.2 1-.8" />
      <path d="M7 16.5v2.4" />
      <path d="M15 16.5v2.4" />
    </svg>
  )
}

/**
 * Tom: `icon-time`.
 *
 * A van do leva-e-traz. Divide o tom com o calendário de propósito: o Taxi Dog é
 * agenda que anda, e no menu ele fica ao lado dela.
 */
/**
 * Van — o Táxi Dog. Tom: `icon-time`.
 *
 * O mesmo azul da Agenda, e não um tom próprio, porque é o que o menu já faz: a corrida
 * é um item do agendamento, não um assunto à parte.
 */
export function VanIcon() {
  return (
    <svg {...BASE}>
      <path d="M2 17V7a1 1 0 0 1 1-1h11v11" />
      <path d="M14 9h4l3 4v4h-2" />
      <circle cx="7" cy="17" r="2" />
      <circle cx="17" cy="17" r="2" />
      <path d="M9 17h6" />
    </svg>
  )
}

/** Tom: `icon-money`. */
export function WalletIcon() {
  return (
    <svg {...BASE}>
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </svg>
  )
}

/** Tom: `icon-health`. */
export function HeartPulseIcon() {
  return (
    <svg {...BASE}>
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      <path d="M3.5 13H9l.5-1 2 4.5 2-7 1.5 3.5h5.2" />
    </svg>
  )
}

/**
 * Sino — a mensagem que sai sozinha. Tom: `icon-metric`.
 *
 * Não é o teal por ser métrica: é o único tom que ainda não tinha dono, e mensagem
 * automática não pertence a nenhum dos módulos que ela atravessa — nasce da agenda,
 * fala do pet e é lida pelo tutor.
 */
export function BellIcon() {
  return (
    <svg {...BASE}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

/* ── Glifos de formulário ──────────────────────────────────────────────────
 *
 * Menores em intenção que os de cima: não representam um módulo, e sim o tipo de
 * dado que o campo espera. Entram no adorno de `.field-wrap`, em 18px, herdando a
 * cor do campo — daí não terem tom próprio.
 */

/** Adorno do campo de telefone. */
export function PhoneIcon() {
  return (
    <svg {...BASE} width={18} height={18}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2Z" />
    </svg>
  )
}

/** Adorno do campo de e-mail. */
export function MailIcon() {
  return (
    <svg {...BASE} width={18} height={18}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 8.9 5.9a2 2 0 0 0 2.2 0L22 7" />
    </svg>
  )
}

/** Adorno do campo de CEP. */
export function MapPinIcon() {
  return (
    <svg {...BASE} width={18} height={18}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  )
}

/** Adorno do campo de CPF/CNPJ. */
export function DocumentIcon() {
  return (
    <svg {...BASE} width={18} height={18}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h6" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  )
}

/** Adorno do campo de data. */
export function CakeIcon() {
  return (
    <svg {...BASE} width={18} height={18}>
      <path d="M4 14a2 2 0 0 1 2 2 2 2 0 0 0 4 0 2 2 0 0 1 4 0 2 2 0 0 0 4 0 2 2 0 0 1 2-2" />
      <path d="M4 12a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9H4Z" />
      <path d="M12 7V5M8 7V6M16 7V6" />
    </svg>
  )
}

/**
 * Bloco de anotação — o campo livre. Sem tom próprio.
 *
 * Observação não é um domínio: é onde cai o que não coube nos campos, e o que ela
 * significa depende de qual ficha a contém. Assume o tom de quem a embrulha.
 */
export function NoteIcon() {
  return (
    <svg {...BASE}>
      <path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9Z" />
      <path d="M15 3v6h6" />
      <path d="M8 13h7M8 17h5" />
    </svg>
  )
}

/**
 * Escudo com tique — o aceite registrado. Sem tom próprio.
 *
 * Consentimento é uma seção de ficha, não um módulo: aparece no cadastro do tutor
 * e no portal dele, e nos dois herda o tom de quem o embrulha.
 */
export function ShieldCheckIcon() {
  return (
    <svg {...BASE}>
      <path d="M20 12c0 5-3.5 7.7-7.4 9.1a1.7 1.7 0 0 1-1.2 0C7.5 19.7 4 17 4 12V6.4a1.7 1.7 0 0 1 1.1-1.6l6.3-2.3a1.7 1.7 0 0 1 1.2 0l6.3 2.3A1.7 1.7 0 0 1 20 6.4Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

/** Triângulo de atenção — o aviso que interrompe. Sem tom: herda a cor do alerta. */
export function AlertTriangleIcon() {
  return (
    <svg {...BASE}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  )
}

/**
 * Duas fichas sobrepostas — o cadastro que pode já existir. Sem tom.
 *
 * Duplicata precisa de um desenho que diga "isto e aquilo são a mesma coisa", e
 * sobreposição é a única metáfora que faz isso sem texto.
 */
export function CopyIcon() {
  return (
    <svg {...BASE}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

/**
 * Anel de carregamento do adorno de campo.
 *
 * Gira com `animate-spin` do Tailwind e some sob `prefers-reduced-motion` porque o
 * texto ao lado já diz o que está acontecendo — rotação contínua é exatamente o
 * tipo de movimento que quem pediu menos movimento não quer.
 */
export function SpinnerIcon() {
  return (
    <svg
      {...BASE}
      width={16}
      height={16}
      className="motion-safe:animate-spin motion-reduce:hidden"
      strokeWidth={2}
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

/** Paleta — identidade visual. Sem tom próprio: assume o da tela que a embrulha. */
export function PaletteIcon() {
  return (
    <svg {...BASE}>
      <path d="M12 21a9 9 0 1 1 9-9c0 1.7-1.3 3-3 3h-1.5a2 2 0 0 0-1.4 3.4A2 2 0 0 1 13.7 21Z" />
      <circle cx="7.5" cy="12" r="1" />
      <circle cx="9.5" cy="8" r="1" />
      <circle cx="14" cy="7.5" r="1" />
    </svg>
  )
}

/** O site do estabelecimento: a superfície que o mundo alcança. */
export function GlobeIcon() {
  return (
    <svg {...BASE} width={18} height={18}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
    </svg>
  )
}

/** A vitrine de serviços e a galeria: o que o site mostra. */
export function ImageIcon() {
  return (
    <svg {...BASE} width={18} height={18}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.6" />
      <path d="m21 15-4.5-4.5L7 20" />
    </svg>
  )
}

/** O contato que chegou pelo formulário e ainda não é cliente. */
export function InboxIcon() {
  return (
    <svg {...BASE} width={18} height={18}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1Z" />
    </svg>
  )
}
