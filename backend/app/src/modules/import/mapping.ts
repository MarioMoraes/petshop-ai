import { IMPORT_ENTITIES, IMPORT_ENTITY_LABELS, type ImportEntity } from '@petshop/shared-types'
import {
  CoerceError,
  normalize,
  toAgeMonths,
  toBool,
  toDate,
  toDecimal,
  toDigits,
  toEmail,
  toEnum,
  toInt,
  toList,
  toPhone,
  toText,
  toTimeOfDay,
  toUf,
} from './coerce.js'

/**
 * O catálogo de campos importáveis e o mapeamento coluna → campo — **puro**.
 *
 * É o que separa "importar" de "digitar": o cabeçalho que o sistema antigo exporta não
 * é o nome do nosso campo. Sem sugestão de mapeamento, a importação só funcionaria com
 * um arquivo escrito por nós, e o petshop voltaria a redigitar quatrocentos cadastros —
 * dentro de uma planilha, em vez de dentro do sistema.
 *
 * Duas regras de desenho:
 *
 * - **A sugestão nunca é a última palavra.** `suggestMapping` propõe, a tela mostra, o
 *   humano confirma. Aplicar direto o que o farejador achou é um `INSERT` às cegas:
 *   `Nome` casaria com o do tutor num arquivo em que ela é a do pet, e ninguém veria
 *   antes de a base estar carregada.
 * - **Valor desconhecido levanta, não escolhe.** Um `sexo` escrito "Indefinido" não é
 *   "Macho": a linha vira erro com a lista do que é aceito.
 *
 * `target` diz para onde o valor vai, e existe para o erro de digitação não ser
 * silencioso — os schemas do domínio são não-estritos, então uma chave com nome errado
 * seria descartada no parse e o campo apareceria vazio na base sem nenhuma mensagem.
 *
 * - `payload` — vai direto ao schema de criação do módulo dono;
 * - `address` — compõe o endereço principal do tutor;
 * - `consent` — compõe o bloco de consentimento do tutor;
 * - `ref` — não é campo do domínio: é a chave que o serviço usa para **resolver** (o
 *   CPF do tutor do pet, o nome do profissional) ou para **decidir**.
 */

export interface FieldSpec {
  field: string
  label: string
  target: 'payload' | 'address' | 'consent' | 'ref'
  required?: boolean
  /** Como o sistema antigo escreve esta coluna. Comparado por `normalize`. */
  synonyms: readonly string[]
  coerce: (raw: string) => unknown
  /** Uma célula de exemplo — é o que o modelo CSV da tela mostra. */
  example: string
  /** Uma frase quando o campo precisa de explicação na tela. */
  hint?: string
  /**
   * Pode dividir a coluna com outro campo.
   *
   * Existe por um caso só e real: a agenda exportada num campo só
   * (`31/12/2026 14:30`). A regra normal é que uma coluna serve a um campo — sem ela,
   * num arquivo com `Nome` e `Nome do tutor` os dois cairiam no mesmo lugar.
   */
  sharesColumn?: boolean
}

/** `campo → índice da coluna no arquivo`. Campo ausente = não mapeado. */
export type Mapping = Record<string, number>

/* ═══════════════════════════════════════════ Dicionários compartilhados */

const SIM = 'Sim'

const PERSON_TYPE = {
  PF: ['fisica', 'f', 'pessoa fisica', 'pf', 'cpf'],
  PJ: ['juridica', 'j', 'pessoa juridica', 'pj', 'empresa', 'cnpj'],
} as const

const PET_SEX = {
  MALE: ['m', 'macho', 'masculino', 'male'],
  FEMALE: ['f', 'femea', 'feminino', 'female'],
  UNKNOWN: ['i', 'indefinido', 'nao sei', 'desconhecido', '-'],
} as const

/**
 * O papel do profissional.
 *
 * O vocabulário é o do balcão, não o nosso: quem exporta escreve "Tosador" e
 * "Veterinário". `DRIVER` está aqui porque o motorista do Taxi Dog é um profissional
 * como os outros — o que ele não faz é atender pet, e essa regra é do MOD-AGENDA.
 */
const PROFESSIONAL_ROLE = {
  GROOMER: ['tosador', 'tosadora', 'tosa', 'groomer', 'esteticista'],
  BATHER: ['banhista', 'banho', 'auxiliar de banho', 'bather'],
  VET: ['veterinario', 'veterinaria', 'vet', 'medico veterinario', 'clinico'],
  DRIVER: ['motorista', 'condutor', 'driver', 'taxi dog', 'leva e traz'],
} as const

/* ═══════════════════════════════════════════════════════ Catálogo */

const TUTOR: readonly FieldSpec[] = [
  {
    field: 'fullName',
    label: 'Nome do tutor',
    target: 'payload',
    required: true,
    coerce: toText,
    example: 'Maria Aparecida Souza',
    synonyms: [
      'nome',
      'nome completo',
      'cliente',
      'tutor',
      'responsavel',
      'dono',
      'proprietario',
      'razao social',
    ],
  },
  {
    field: 'phone',
    label: 'Celular',
    target: 'payload',
    required: true,
    coerce: toPhone,
    example: '(11) 98888-7777',
    hint: 'É o canal do petshop com o cliente e a chave do atendimento por WhatsApp. Sem ele o cadastro não existe.',
    synonyms: [
      'celular',
      'cel',
      'whatsapp',
      'zap',
      'telefone',
      'fone',
      'tel',
      'contato',
      'telefone 1',
    ],
  },
  {
    field: 'phoneAlt',
    label: 'Telefone alternativo',
    target: 'payload',
    coerce: toPhone,
    example: '(11) 3333-4444',
    synonyms: [
      'telefone 2',
      'telefone fixo',
      'fixo',
      'recado',
      'telefone alternativo',
      'outro telefone',
      'residencial',
    ],
  },
  {
    field: 'personType',
    label: 'Pessoa física/jurídica',
    target: 'payload',
    coerce: (raw) => toEnum(raw, PERSON_TYPE),
    example: 'Física',
    synonyms: ['tipo pessoa', 'pf/pj', 'pf pj', 'natureza', 'fisica/juridica', 'tipo de cliente'],
  },
  {
    field: 'cpf',
    label: 'CPF',
    target: 'payload',
    coerce: toDigits,
    example: '123.456.789-09',
    hint: 'Quando existe, é a chave que impede o mesmo cliente de entrar duas vezes.',
    synonyms: ['cpf', 'documento', 'doc', 'cpf/cnpj'],
  },
  {
    field: 'cnpj',
    label: 'CNPJ',
    target: 'payload',
    coerce: toDigits,
    example: '12.345.678/0001-99',
    synonyms: ['cnpj', 'cnpj cliente'],
  },
  {
    field: 'legalName',
    label: 'Razão social',
    target: 'payload',
    coerce: toText,
    example: 'Souza Pet Ltda',
    synonyms: ['razao social', 'nome empresarial'],
  },
  {
    field: 'socialName',
    label: 'Nome social',
    target: 'payload',
    coerce: toText,
    example: 'Mary Souza',
    hint: 'Quando preenchido, é o nome que aparece nas telas e nas mensagens.',
    synonyms: ['nome social', 'apelido', 'como prefere ser chamado'],
  },
  {
    field: 'email',
    label: 'E-mail',
    target: 'payload',
    coerce: toEmail,
    example: 'maria@exemplo.com.br',
    synonyms: ['email', 'e-mail', 'correio eletronico'],
  },
  {
    field: 'birthDate',
    label: 'Nascimento do tutor',
    target: 'payload',
    coerce: toDate,
    example: '15/03/1980',
    synonyms: [
      'nascimento',
      'data nascimento',
      'data de nascimento',
      'dt nascimento',
      'aniversario',
    ],
  },
  {
    field: 'notes',
    label: 'Observações',
    target: 'payload',
    coerce: toText,
    example: 'Prefere contato por WhatsApp',
    synonyms: ['observacao', 'observacoes', 'obs', 'anotacoes', 'comentarios'],
  },
  {
    field: 'address.zipCode',
    label: 'CEP',
    target: 'address',
    coerce: toDigits,
    example: '01310-100',
    hint: 'O endereço só entra completo: sem CEP, logradouro, número, bairro, cidade e UF ele é ignorado e o cadastro continua.',
    synonyms: ['cep', 'codigo postal'],
  },
  {
    field: 'address.street',
    label: 'Logradouro',
    target: 'address',
    coerce: toText,
    example: 'Avenida Paulista',
    synonyms: ['endereco', 'logradouro', 'rua', 'endereco residencial'],
  },
  {
    field: 'address.number',
    label: 'Número',
    target: 'address',
    coerce: toText,
    example: '1000',
    synonyms: ['numero', 'num', 'nr', 'nro', 'n', 'no', 'numero endereco'],
  },
  {
    field: 'address.complement',
    label: 'Complemento',
    target: 'address',
    coerce: toText,
    example: 'Apto 52',
    synonyms: ['complemento', 'compl', 'apto', 'apartamento'],
  },
  {
    field: 'address.district',
    label: 'Bairro',
    target: 'address',
    coerce: toText,
    example: 'Bela Vista',
    synonyms: ['bairro'],
  },
  {
    field: 'address.city',
    label: 'Cidade',
    target: 'address',
    coerce: toText,
    example: 'São Paulo',
    synonyms: ['cidade', 'municipio'],
  },
  {
    field: 'address.state',
    label: 'UF',
    target: 'address',
    coerce: toUf,
    example: 'SP',
    synonyms: ['uf', 'estado'],
  },
  {
    field: 'consent.whatsapp',
    label: 'Aceita WhatsApp de promoções',
    target: 'consent',
    coerce: toBool,
    example: SIM,
    hint: 'Sem coluna, nasce NÃO. Consentimento de marketing não se presume — o lembrete do banho continua saindo, porque é transacional.',
    synonyms: [
      'aceita whatsapp',
      'consentimento whatsapp',
      'promocoes',
      'marketing',
      'aceita promocao',
      'opt-in',
    ],
  },
  {
    field: 'consent.email',
    label: 'Aceita e-mail de promoções',
    target: 'consent',
    coerce: toBool,
    example: SIM,
    hint: 'Sem coluna, nasce NÃO — pela mesma razão do WhatsApp.',
    synonyms: ['aceita email', 'consentimento email', 'newsletter', 'mala direta'],
  },
  {
    field: 'consent.imageUse',
    label: 'Autoriza uso de imagem',
    target: 'consent',
    coerce: toBool,
    example: SIM,
    hint: 'A foto do banho pronto nas redes do petshop. Sem coluna, nasce NÃO.',
    synonyms: ['uso de imagem', 'autoriza imagem', 'direito de imagem', 'foto'],
  },
]

const PET: readonly FieldSpec[] = [
  {
    field: 'tutorRef',
    label: 'CPF ou celular do tutor',
    target: 'ref',
    required: true,
    coerce: toText,
    example: '123.456.789-09',
    hint: 'É o que liga o pet ao dono. Use a mesma coluna que identificou o tutor no passo 1 — CPF, CNPJ ou celular.',
    synonyms: [
      'cpf',
      'cpf tutor',
      'cpf do tutor',
      'documento tutor',
      'celular tutor',
      'telefone tutor',
      'cpf/cnpj',
      'cliente',
      'codigo cliente',
    ],
  },
  {
    field: 'name',
    label: 'Nome do pet',
    target: 'payload',
    required: true,
    coerce: toText,
    example: 'Thor',
    synonyms: ['nome', 'nome do pet', 'pet', 'animal', 'nome animal', 'paciente'],
  },
  {
    field: 'species',
    label: 'Espécie',
    target: 'ref',
    required: true,
    coerce: toText,
    example: 'Cão',
    hint: 'Comparada com o catálogo do estabelecimento: Cão, Gato e o que mais estiver cadastrado.',
    synonyms: ['especie', 'tipo', 'tipo de animal', 'animal'],
  },
  {
    field: 'breed',
    label: 'Raça',
    target: 'ref',
    coerce: toText,
    example: 'Golden Retriever',
    hint: 'Raça que não existe no catálogo é cadastrada na hora — a lista é o vocabulário da clientela, não o nosso.',
    synonyms: ['raca', 'breed'],
  },
  {
    field: 'size',
    label: 'Porte',
    target: 'ref',
    required: true,
    coerce: toText,
    example: 'Grande',
    hint: 'Decide preço e duração do banho. Quando a planilha não traz, o porte da raça cadastrada é usado.',
    synonyms: ['porte', 'tamanho', 'size'],
  },
  {
    field: 'coat',
    label: 'Pelagem',
    target: 'ref',
    coerce: toText,
    example: 'Longa',
    hint: 'Multiplica a duração da tosa. Sem ela, o tempo sai só do porte.',
    synonyms: ['pelagem', 'pelo', 'pelo/pelagem', 'tipo de pelo'],
  },
  {
    field: 'sex',
    label: 'Sexo',
    target: 'payload',
    coerce: (raw) => toEnum(raw, PET_SEX),
    example: 'Macho',
    synonyms: ['sexo', 'genero'],
  },
  {
    field: 'birthDate',
    label: 'Nascimento',
    target: 'payload',
    coerce: toDate,
    example: '10/07/2021',
    synonyms: [
      'nascimento',
      'data nascimento',
      'data de nascimento',
      'dt nascimento',
      'aniversario',
    ],
  },
  {
    field: 'estimatedAgeMonths',
    label: 'Idade',
    target: 'payload',
    coerce: toAgeMonths,
    example: '4 anos',
    hint: 'Usada quando não há data de nascimento. Número seco é lido como anos ("4" = 4 anos); para filhote, escreva "8 meses".',
    synonyms: ['idade', 'idade aproximada', 'idade estimada', 'anos'],
  },
  {
    field: 'weightKg',
    label: 'Peso (kg)',
    target: 'payload',
    coerce: toDecimal,
    example: '32,5',
    synonyms: ['peso', 'peso kg', 'kg', 'peso atual'],
  },
  {
    field: 'neutered',
    label: 'Castrado',
    target: 'payload',
    coerce: toBool,
    example: SIM,
    synonyms: ['castrado', 'castrada', 'castracao', 'esterilizado'],
  },
  {
    field: 'microchip',
    label: 'Microchip',
    target: 'payload',
    coerce: toDigits,
    example: '981020000123456',
    synonyms: ['microchip', 'chip', 'numero do chip', 'identificacao'],
  },
  {
    field: 'color',
    label: 'Cor',
    target: 'payload',
    coerce: toText,
    example: 'Dourado',
    synonyms: ['cor', 'pelagem cor', 'cor do pelo'],
  },
  {
    field: 'notes',
    label: 'Observações',
    target: 'payload',
    coerce: toText,
    example: 'Não gosta de secador na cabeça',
    hint: 'Alergia e temperamento entram no prontuário, que tem tela própria — aqui a observação é livre.',
    synonyms: ['observacao', 'observacoes', 'obs', 'anotacoes', 'comentarios'],
  },
]

const PROFISSIONAL: readonly FieldSpec[] = [
  {
    field: 'displayName',
    label: 'Nome',
    target: 'payload',
    required: true,
    coerce: toText,
    example: 'Ana Paula',
    hint: 'É a chave do passo: o mesmo nome numa segunda carga atualiza, não duplica. É também o que a coluna da agenda usa.',
    synonyms: ['nome', 'profissional', 'funcionario', 'colaborador', 'nome completo'],
  },
  {
    field: 'roleKey',
    label: 'Função',
    target: 'payload',
    required: true,
    coerce: (raw) => toEnum(raw, PROFESSIONAL_ROLE),
    example: 'Tosador',
    hint: 'Tosador, Banhista, Veterinário ou Motorista. Motorista não recebe agendamento de banho — ele opera o Taxi Dog.',
    synonyms: ['funcao', 'cargo', 'papel', 'tipo', 'especialidade', 'perfil'],
  },
  {
    field: 'services',
    label: 'Serviços que executa',
    target: 'ref',
    coerce: toList,
    example: 'Banho/Tosa higiênica',
    hint: 'Separados por barra ou vírgula, com o nome que têm no catálogo de serviços. Sem isto ninguém consegue marcar com esta pessoa.',
    synonyms: ['servicos', 'servico', 'habilidades', 'executa', 'atende'],
  },
  {
    field: 'maxConcurrentPets',
    label: 'Pets ao mesmo tempo',
    target: 'payload',
    coerce: toInt,
    example: '2',
    hint: 'Capacidade simultânea: o banhista lava um, põe para secar e começa o próximo. Sem coluna, 1.',
    synonyms: ['capacidade', 'pets simultaneos', 'simultaneos', 'atendimentos simultaneos'],
  },
  {
    field: 'color',
    label: 'Cor na agenda',
    target: 'payload',
    coerce: toText,
    example: '#2F6FED',
    synonyms: ['cor', 'cor agenda'],
  },
  {
    field: 'crmv',
    label: 'CRMV',
    target: 'payload',
    coerce: toText,
    example: '12345',
    hint: 'Só do veterinário, e só o número — a UF vai na coluna ao lado. Sem o par, não há receituário.',
    synonyms: ['crmv', 'registro', 'conselho', 'numero crmv'],
  },
  {
    field: 'crmvState',
    label: 'UF do CRMV',
    target: 'payload',
    coerce: toUf,
    example: 'SP',
    synonyms: ['uf crmv', 'estado crmv', 'crmv uf'],
  },
]

const AGENDA: readonly FieldSpec[] = [
  {
    field: 'tutorRef',
    label: 'CPF ou celular do tutor',
    target: 'ref',
    required: true,
    coerce: toText,
    example: '123.456.789-09',
    hint: 'Junto com o nome do pet, é o que identifica quem vem. Dois pets chamados Thor de tutores diferentes não se confundem.',
    synonyms: [
      'cpf',
      'cpf tutor',
      'cpf do tutor',
      'documento tutor',
      'celular tutor',
      'telefone tutor',
      'cliente',
      'cpf/cnpj',
    ],
  },
  {
    field: 'petName',
    label: 'Nome do pet',
    target: 'ref',
    required: true,
    coerce: toText,
    example: 'Thor',
    synonyms: ['pet', 'nome do pet', 'animal', 'nome animal', 'paciente'],
  },
  {
    field: 'professional',
    label: 'Profissional',
    target: 'ref',
    required: true,
    coerce: toText,
    example: 'Ana Paula',
    hint: 'O mesmo nome cadastrado no passo 3.',
    synonyms: [
      'profissional',
      'funcionario',
      'responsavel',
      'tosador',
      'banhista',
      'atendente',
      'quem atende',
    ],
  },
  {
    field: 'services',
    label: 'Serviços',
    target: 'ref',
    required: true,
    coerce: toList,
    example: 'Banho/Tosa higiênica',
    hint: 'Com o nome que têm no catálogo. O preço e a duração saem da tabela do porte do pet, não da planilha.',
    synonyms: ['servico', 'servicos', 'procedimento', 'atendimento', 'tipo de servico'],
  },
  {
    field: 'date',
    label: 'Data',
    target: 'ref',
    required: true,
    coerce: toDate,
    example: '05/10/2026',
    hint: 'Só o que ainda vai acontecer. O que já passou fica no sistema antigo — ver a nota ao lado.',
    synonyms: ['data', 'dia', 'data agendamento', 'data/hora', 'data hora', 'quando'],
  },
  {
    field: 'time',
    label: 'Horário',
    target: 'ref',
    required: true,
    coerce: toTimeOfDay,
    example: '14:30',
    hint: 'A hora do relógio do estabelecimento. Quando data e hora estão na mesma coluna, aponte as duas para ela.',
    sharesColumn: true,
    synonyms: ['hora', 'horario', 'hr', 'data/hora', 'data hora', 'hora agendamento'],
  },
  {
    field: 'notes',
    label: 'Observações',
    target: 'payload',
    coerce: toText,
    example: 'Buscar às 13h',
    synonyms: ['observacao', 'observacoes', 'obs', 'anotacoes', 'comentarios'],
  },
]

export const CATALOG: Record<ImportEntity, readonly FieldSpec[]> = {
  TUTOR,
  PET,
  PROFISSIONAL,
  AGENDA,
}

/** A frase que abre cada passo na tela. */
export const ENTITY_DESCRIPTIONS: Record<ImportEntity, string> = {
  TUTOR:
    'Os clientes. Quem já existe é reconhecido pelo CPF/CNPJ ou, na falta dele, pelo celular — subir duas vezes não duplica ninguém.',
  PET: 'Os animais. Cada linha aponta o dono pelo CPF ou pelo celular, então os tutores precisam ter entrado antes.',
  PROFISSIONAL:
    'Quem atende. A jornada de trabalho não vem da planilha: cadastre-a em Agenda › Profissionais antes de importar os agendamentos.',
  AGENDA:
    'Os horários marcados que ainda vão acontecer. Cada um passa pelas mesmas regras do balcão — jornada, capacidade e habilitação do profissional.',
}

export { IMPORT_ENTITY_LABELS as ENTITY_LABELS, IMPORT_ENTITIES as ENTITIES }

/* ═══════════════════════════════════════════════════════ Mapeamento */

/**
 * Propõe `campo → coluna` comparando o cabeçalho do arquivo com os sinônimos.
 *
 * Duas passadas, e a ordem importa: primeiro a igualdade exata (normalizada), depois o
 * "contém". Sem isso, num arquivo com `Nome` e `Nome do tutor` a coluna do tutor
 * poderia ser escolhida para o nome do pet só por vir antes — e quatrocentos pets
 * entrariam chamados como os donos.
 *
 * Uma coluna nunca serve a dois campos: o primeiro que a reivindica a consome. A
 * exceção é `sharesColumn`, que existe para a agenda exportada com data e hora na mesma
 * célula, e roda numa terceira passada — depois de todo mundo ter tido a sua chance.
 */
export function suggestMapping(entity: ImportEntity, headers: readonly string[]): Mapping {
  const specs = CATALOG[entity]
  const normalized = headers.map(normalize)
  const taken = new Set<number>()
  const mapping: Mapping = {}

  const claim = (spec: FieldSpec, exact: boolean, respectTaken: boolean): void => {
    if (mapping[spec.field] !== undefined) return

    const candidates = [normalize(spec.label), ...spec.synonyms.map(normalize)]
    const index = normalized.findIndex(
      (header, position) =>
        (!respectTaken || !taken.has(position)) &&
        header !== '' &&
        (exact
          ? candidates.includes(header)
          : candidates.some((candidate) => candidate.length >= 3 && header.includes(candidate))),
    )

    if (index >= 0) {
      mapping[spec.field] = index
      taken.add(index)
    }
  }

  for (const exact of [true, false]) {
    for (const spec of specs) claim(spec, exact, true)
  }

  for (const spec of specs) {
    if (spec.sharesColumn) claim(spec, false, false)
  }

  return mapping
}

/** Campos obrigatórios que o mapeamento não cobre — nada é gravado enquanto houver um. */
export function missingRequired(entity: ImportEntity, mapping: Mapping): string[] {
  return CATALOG[entity]
    .filter((spec) => spec.required && mapping[spec.field] === undefined)
    .map((spec) => spec.label)
}

export interface RowValues {
  /** O que vai ao schema de criação do módulo dono. */
  payload: Record<string, unknown>
  /** O endereço principal do tutor, quando alguma coluna veio preenchida. */
  address: Record<string, unknown> | null
  /** O bloco de consentimento do tutor. */
  consent: Record<string, boolean>
  /** Chaves de resolução e decisão (CPF do tutor, nome do profissional, data). */
  refs: Record<string, unknown>
  /** Mensagens de célula que não converteu. Linha com erro não é gravada. */
  errors: string[]
}

/**
 * Aplica o mapeamento e os conversores a uma linha.
 *
 * **Todas** as células são tentadas antes de desistir: parar no primeiro erro faria o
 * operador corrigir uma coluna, subir de novo e descobrir a segunda — um ciclo de
 * quatrocentas linhas por vez. O relatório de uma passada tem de listar tudo o que está
 * errado naquela linha.
 */
export function readRow(
  entity: ImportEntity,
  mapping: Mapping,
  cells: readonly string[],
): RowValues {
  const values: RowValues = { payload: {}, address: null, consent: {}, refs: {}, errors: [] }

  for (const spec of CATALOG[entity]) {
    const index = mapping[spec.field]
    if (index === undefined) continue

    const raw = cells[index] ?? ''
    let value: unknown
    try {
      value = spec.coerce(raw)
    } catch (error) {
      values.errors.push(
        `${spec.label}: ${error instanceof CoerceError ? error.message : String(error)}`,
      )
      continue
    }
    if (value === undefined) continue

    if (spec.target === 'ref') values.refs[spec.field] = value
    else if (spec.target === 'address') {
      values.address ??= {}
      values.address[spec.field.slice('address.'.length)] = value
    } else if (spec.target === 'consent') {
      values.consent[spec.field.slice('consent.'.length)] = value as boolean
    } else values.payload[spec.field] = value
  }

  return values
}

/**
 * O modelo CSV de um passo: cabeçalho com os nossos rótulos + uma linha de exemplo.
 *
 * O cabeçalho sai LIMPO, sem marcar os obrigatórios com asterisco: quem baixa o modelo
 * preenche e sobe de volta, e um `Nome do pet *` deixaria de casar com o próprio
 * sinônimo. Quais campos são obrigatórios é a tela que mostra, a partir do catálogo.
 *
 * Separador `;` e não `,`: é o que o Excel em pt-BR abre em colunas ao dar duplo
 * clique. Com vírgula o arquivo abre numa coluna só, e o operador conclui que o modelo
 * está quebrado.
 */
export function templateCsv(entity: ImportEntity): string {
  const specs = CATALOG[entity]
  return `${specs.map((spec) => spec.label).join(';')}\n${specs.map((spec) => spec.example).join(';')}\n`
}
