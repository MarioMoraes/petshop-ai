import {
  BirdIcon,
  CatIcon,
  DogIcon,
  PawPrintIcon,
  ReptileIcon,
  RodentIcon,
} from './icons'

/**
 * A cara do pet nas listagens e na ficha.
 *
 * Sem foto, o lugar não fica vazio nem mostra a inicial do nome: mostra o **ícone da
 * espécie**. A inicial era uma pista fraca — cinco "Mel" no mesmo tenant dão cinco
 * círculos com "M", que é exatamente o caso que a RN-16 diz que a foto resolve. O
 * ícone não desambigua dois cães, mas separa o cão do gato num relance, e é
 * informação de verdade em vez de enfeite.
 *
 * A chave vem do catálogo (`species.key`), não do rótulo: o tenant pode renomear
 * "Cão" para "Cachorro" e o ícone tem de continuar certo. Espécie desconhecida — ou
 * uma criada pelo tenant, que nasce com chave própria — cai na patinha, que é
 * genérica de propósito.
 */

const SPECIES_ICONS: Record<string, () => React.JSX.Element> = {
  DOG: DogIcon,
  CAT: CatIcon,
  BIRD: BirdIcon,
  RODENT: RodentIcon,
  REPTILE: ReptileIcon,
  OTHER: PawPrintIcon,
}

/** O ícone da espécie solto, sem o círculo — o filtro de `/pets` usa. */
export function SpeciesIcon({ speciesKey }: { speciesKey: string }) {
  const Icon = SPECIES_ICONS[speciesKey] ?? PawPrintIcon
  return <Icon />
}

const SIZES = {
  sm: 'h-10 w-10',
  md: 'h-12 w-12',
  lg: 'h-16 w-16',
} as const

/**
 * O ícone dentro do círculo, por tamanho.
 *
 * Os ícones do sistema nascem com `width`/`height` de 20px no atributo do `<svg>`, o
 * que serve ao menu mas fica pequeno demais num círculo de 48: sobra anel e falta
 * bicho. A classe vence o atributo, e é assim que o mesmo ícone atende os dois usos
 * sem uma segunda versão dele.
 */
const ICON_SIZES = {
  sm: '[&>svg]:h-5 [&>svg]:w-5',
  md: '[&>svg]:h-6 [&>svg]:w-6',
  lg: '[&>svg]:h-8 [&>svg]:w-8',
} as const

interface Props {
  /** URL assinada da capa. Nulo cai no ícone da espécie. */
  coverPhotoUrl: string | null
  /** `species.key` do catálogo: DOG, CAT, BIRD, RODENT, REPTILE, OTHER. */
  speciesKey: string
  /** Só para o `alt` da foto. O ícone é decorativo e fica `aria-hidden`. */
  petName: string
  size?: keyof typeof SIZES
  className?: string
}

export function PetAvatar({
  coverPhotoUrl,
  speciesKey,
  petName,
  size = 'md',
  className = '',
}: Props) {
  const box = `${SIZES[size]} shrink-0 rounded-full ${className}`

  if (coverPhotoUrl) {
    return (
      // A URL do R2 é assinada e vence em 15 minutos; o otimizador do Next cacheia
      // por URL e acabaria servindo um endereço morto.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={coverPhotoUrl}
        alt={`Foto de ${petName}`}
        className={`${box} object-cover`}
        loading="lazy"
      />
    )
  }

  const Icon = SPECIES_ICONS[speciesKey] ?? PawPrintIcon

  return (
    // Mesmas variáveis do `.icon-chip` do design, mas redondo: o círculo é o que faz
    // o espaço não "pular" quando metade da lista tem foto e a outra metade não.
    <span
      aria-hidden
      className={`icon-pet flex items-center justify-center bg-[var(--icon-soft)] text-[var(--icon)] shadow-[0_0_0_1px_var(--icon-ring)_inset] ${ICON_SIZES[size]} ${box}`}
    >
      <Icon />
    </span>
  )
}
