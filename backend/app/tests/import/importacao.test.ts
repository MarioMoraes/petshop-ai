import { withTenant } from '@petshop/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asRole,
  callApi,
  closeHarness,
  csv,
  csvLatin1,
  emDiasBR,
  givenSchedule,
  givenService,
  givenTenant,
  resetDatabase,
  type Caller,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-IMPORT — a carga da base do sistema anterior, ponta a ponta.
 *
 * O que estes testes seguram é a promessa que o módulo faz: **analisar e aplicar são o
 * mesmo código**, o que já entrou não entra de novo, e o que a linha não conseguiu fazer
 * volta nomeado em vez de derrubar a carga inteira.
 */

let fixture: TenantFixture
let admin: Caller

beforeEach(async () => {
  await resetDatabase()
  fixture = await givenTenant()
  admin = asAdmin(fixture)
})

afterAll(closeHarness)

/* ═══════════════════════════════════════════════════ Porta */

describe('quem pode importar', () => {
  it('a recepção não alcança a importação', async () => {
    /**
     * A permissão é própria (`import:run`) e a matriz do MOD-IDENT-04 a dá só ao
     * administrador. A recepção tem `tutor:create` e `pet:create` — e é justamente o que
     * não basta: uma tacada aqui cria clientes, animais, equipe e agenda de uma vez.
     */
    const recepcao = await asRole(fixture, 'RECEPTIONIST')
    const resposta = await callApi({ ...recepcao, method: 'GET', url: '/v1/import/entities' })

    expect(resposta.statusCode).toBe(403)
  })

  it('o catálogo de campos traz o modelo CSV pronto', async () => {
    const resposta = await callApi({ ...admin, method: 'GET', url: '/v1/import/entities' })
    expect(resposta.statusCode).toBe(200)

    const { items } = resposta.json() as { items: { entity: string; template: string }[] }
    expect(items.map((item) => item.entity)).toEqual(['TUTOR', 'PET', 'PROFISSIONAL', 'AGENDA'])
    // O modelo vem do mesmo catálogo que valida a carga — daí ele nunca divergir.
    expect(items[0]?.template).toContain('Nome do tutor;Celular')
  })
})

/* ═══════════════════════════════════════════════════ Tutores */

const CABECALHO_TUTOR = ['Cliente', 'CPF', 'Celular', 'E-mail']

async function analisarTutores(linhas: string[][], mapping?: Record<string, number>) {
  return callApi({
    ...admin,
    method: 'POST',
    url: '/v1/import/analyze',
    payload: {
      entity: 'TUTOR',
      fileName: 'clientes.csv',
      content: csv([CABECALHO_TUTOR, ...linhas]),
      ...(mapping ? { mapping } : {}),
    },
  })
}

async function aplicarTutores(linhas: string[][], onExisting: 'IGNORAR' | 'ATUALIZAR' = 'IGNORAR') {
  const analise = await analisarTutores(linhas)
  const { mapping } = analise.json() as { mapping: Record<string, number> }

  return callApi({
    ...admin,
    method: 'POST',
    url: '/v1/import/apply',
    payload: {
      entity: 'TUTOR',
      fileName: 'clientes.csv',
      content: csv([CABECALHO_TUTOR, ...linhas]),
      mapping,
      onExisting,
    },
  })
}

describe('tutores', () => {
  it('a análise reconhece as colunas e NÃO grava nada', async () => {
    const resposta = await analisarTutores([
      ['Ana Souza', '529.982.247-25', '(11) 98888-7777', 'ana@exemplo.com'],
    ])

    expect(resposta.statusCode).toBe(200)
    const report = resposta.json() as {
      counts: { created: number }
      delimiter: string
      encoding: string
      batchId?: string
    }
    expect(report.counts.created).toBe(1)
    expect(report.delimiter).toBe(';')
    expect(report.encoding).toBe('utf-8')
    expect(report.batchId).toBeUndefined()

    const gravados = await withTenant(fixture.tenantId, (tx) => tx.tutor.count())
    expect(gravados).toBe(0)
  })

  it('aplica, e a segunda passada do mesmo arquivo não duplica ninguém', async () => {
    const linhas = [['Ana Souza', '529.982.247-25', '(11) 98888-7777', 'ana@exemplo.com']]

    const primeira = await aplicarTutores(linhas)
    expect((primeira.json() as { counts: { created: number } }).counts.created).toBe(1)

    const segunda = await aplicarTutores(linhas)
    const report = segunda.json() as { counts: { created: number; ignored: number } }
    expect(report.counts.created).toBe(0)
    expect(report.counts.ignored).toBe(1)

    expect(await withTenant(fixture.tenantId, (tx) => tx.tutor.count())).toBe(1)
  })

  it('sem CPF, quem identifica o cliente é o celular', async () => {
    const linhas = [['Ana Souza', '', '(11) 98888-7777', '']]
    await aplicarTutores(linhas)

    const segunda = await aplicarTutores([['Ana S. Souza', '', '11988887777', '']])
    expect((segunda.json() as { counts: { ignored: number } }).counts.ignored).toBe(1)
  })

  it('ATUALIZAR mexe só no que a planilha traz', async () => {
    await aplicarTutores([['Ana Souza', '529.982.247-25', '(11) 98888-7777', '']])

    await aplicarTutores(
      [['Ana Souza Lima', '529.982.247-25', '(11) 98888-7777', 'ana@exemplo.com']],
      'ATUALIZAR',
    )

    const tutor = await withTenant(fixture.tenantId, (tx) =>
      tx.tutor.findFirstOrThrow({ select: { fullName: true, status: true } }),
    )
    expect(tutor.fullName).toBe('Ana Souza Lima')
    expect(tutor.status).toBe('ACTIVE')
  })

  it('o consentimento nasce com origem IMPORT, e o marketing nasce NÃO', async () => {
    /**
     * O aceite de termo entra porque a relação já existia no sistema anterior, e a
     * origem `IMPORT` é o que diz a quem lê a trilha que a prova é de segunda mão. O
     * consentimento de **promoção** é o oposto: sem uma coluna dizendo sim, nasce não —
     * presumi-lo faria a estreia do sistema ser uma leva de mensagens que ninguém pediu.
     */
    await aplicarTutores([['Ana Souza', '529.982.247-25', '(11) 98888-7777', '']])

    const consentimentos = await withTenant(fixture.tenantId, (tx) =>
      tx.tutorConsent.findMany({ select: { channel: true, granted: true, source: true } }),
    )

    const termos = consentimentos.find((linha) => linha.channel === 'TERMS')
    const whatsapp = consentimentos.find((linha) => linha.channel === 'WHATSAPP')

    expect(termos).toMatchObject({ granted: true, source: 'IMPORT' })
    expect(whatsapp).toMatchObject({ granted: false, source: 'IMPORT' })
  })

  it('a linha torta vira ERRO nomeado, e as vizinhas entram', async () => {
    const resposta = await aplicarTutores([
      ['Ana Souza', '529.982.247-25', '(11) 98888-7777', ''],
      ['Bia Lima', '111.111.111-11', '(11) 97777-6666', ''],
      ['Caio Melo', '', '(11) 96666-5555', ''],
    ])

    const report = resposta.json() as {
      counts: { created: number; failed: number }
      rows: { lineNo: number; outcome: string; message: string | null }[]
    }

    expect(report.counts.created).toBe(2)
    expect(report.counts.failed).toBe(1)

    const errada = report.rows.find((linha) => linha.outcome === 'ERRO')
    expect(errada?.lineNo).toBe(3)
    expect(errada?.message).toContain('CPF')
  })

  it('lê o acento do arquivo salvo pelo Excel em pt-BR', async () => {
    const conteudo = csvLatin1([CABECALHO_TUTOR, ['José Gonçalves', '', '(11) 98888-7777', '']])

    const analise = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/import/analyze',
      payload: { entity: 'TUTOR', fileName: 'clientes.csv', content: conteudo },
    })
    const { mapping, encoding } = analise.json() as {
      mapping: Record<string, number>
      encoding: string
    }
    expect(encoding).toBe('windows-1252')

    await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/import/apply',
      payload: {
        entity: 'TUTOR',
        fileName: 'clientes.csv',
        content: conteudo,
        mapping,
        onExisting: 'IGNORAR',
      },
    })

    const tutor = await withTenant(fixture.tenantId, (tx) =>
      tx.tutor.findFirstOrThrow({ select: { fullName: true } }),
    )
    expect(tutor.fullName).toBe('José Gonçalves')
  })

  it('sem a coluna de um obrigatório, nada roda e a tela recebe o nome do que falta', async () => {
    const resposta = await analisarTutores([['Ana Souza']], { fullName: 0 })
    const report = resposta.json() as { missing: string[]; rows: unknown[] }

    expect(report.missing).toEqual(['Celular'])
    expect(report.rows).toEqual([])
  })

  it('aplicar sem mapeamento confirmado é recusado', async () => {
    const resposta = await callApi({
      ...admin,
      method: 'POST',
      url: '/v1/import/apply',
      payload: {
        entity: 'TUTOR',
        fileName: 'clientes.csv',
        content: csv([CABECALHO_TUTOR, ['Ana', '', '11988887777', '']]),
      },
    })

    expect(resposta.statusCode).toBe(422)
    expect(resposta.json()).toMatchObject({ code: 'ERR_IMPORT_002' })
  })

  it('avisa que este mesmo arquivo já foi aplicado — e não bloqueia', async () => {
    const linhas = [['Ana Souza', '', '(11) 98888-7777', '']]
    await aplicarTutores(linhas)

    const segunda = await analisarTutores(linhas)
    const { previousBatch } = segunda.json() as { previousBatch: { id: string } | null }
    expect(previousBatch).not.toBeNull()
  })
})

/* ═══════════════════════════════════════════════════ Pets */

const CABECALHO_PET = ['CPF do tutor', 'Nome do pet', 'Espécie', 'Raça', 'Porte', 'Idade']

async function aplicarPets(linhas: string[][], onExisting: 'IGNORAR' | 'ATUALIZAR' = 'IGNORAR') {
  const content = csv([CABECALHO_PET, ...linhas])
  const analise = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/import/analyze',
    payload: { entity: 'PET', fileName: 'pets.csv', content },
  })
  const { mapping } = analise.json() as { mapping: Record<string, number> }

  return callApi({
    ...admin,
    method: 'POST',
    url: '/v1/import/apply',
    payload: { entity: 'PET', fileName: 'pets.csv', content, mapping, onExisting },
  })
}

describe('pets', () => {
  beforeEach(async () => {
    await aplicarTutores([['Ana Souza', '529.982.247-25', '(11) 98888-7777', '']])
  })

  it('acha o dono pelo CPF e cadastra a raça que faltava no catálogo', async () => {
    const resposta = await aplicarPets([
      ['529.982.247-25', 'Thor', 'Cão', 'Vira-lata caramelo', 'Grande', '4 anos'],
    ])

    expect((resposta.json() as { counts: { created: number } }).counts.created).toBe(1)

    const pet = await withTenant(fixture.tenantId, (tx) =>
      tx.pet.findFirstOrThrow({
        select: { name: true, breed: { select: { label: true, tenantId: true } }, petTutors: true },
      }),
    )
    expect(pet.name).toBe('Thor')
    // A raça nova é do tenant: a lista é o vocabulário da clientela, não o nosso.
    expect(pet.breed?.label).toBe('Vira-lata caramelo')
    expect(pet.breed?.tenantId).toBe(fixture.tenantId)
    expect(pet.petTutors[0]?.role).toBe('PRIMARY')
  })

  it('a idade em anos vira a data estimada de nascimento', async () => {
    await aplicarPets([['529.982.247-25', 'Thor', 'Cão', '', 'Grande', '4 anos']])

    const pet = await withTenant(fixture.tenantId, (tx) =>
      tx.pet.findFirstOrThrow({ select: { birthDatePrecision: true, birthDate: true } }),
    )
    expect(pet.birthDatePrecision).toBe('ESTIMATED')
    expect(pet.birthDate).not.toBeNull()
  })

  it('pet sem idade nenhuma entra com "não sei", e não é recusado', async () => {
    /**
     * A regra "informe nascimento ou idade" é da **tela**, onde o tutor está na frente e
     * se pergunta. Numa planilha exportada a idade pode não existir em coluna nenhuma, e
     * recusar quatrocentos pets por isso obrigaria a inventar a idade de cada um.
     */
    await aplicarPets([['529.982.247-25', 'Mel', 'Cão', '', 'Pequeno', '']])

    const pet = await withTenant(fixture.tenantId, (tx) =>
      tx.pet.findFirstOrThrow({ where: { name: 'Mel' }, select: { birthDatePrecision: true } }),
    )
    expect(pet.birthDatePrecision).toBe('UNKNOWN')
  })

  it('espécie fora do catálogo vira erro com a lista do que é aceito', async () => {
    const resposta = await aplicarPets([
      ['529.982.247-25', 'Rex', 'Dragão', '', 'Grande', '2 anos'],
    ])

    const report = resposta.json() as { rows: { outcome: string; message: string | null }[] }
    const linha = report.rows[0]
    expect(linha?.outcome).toBe('ERRO')
    expect(linha?.message).toContain('aceitas:')
  })

  it('tutor que não entrou antes manda importar os tutores primeiro', async () => {
    const resposta = await aplicarPets([['111.444.777-35', 'Rex', 'Cão', '', 'Grande', '2 anos']])

    const report = resposta.json() as { rows: { outcome: string; message: string | null }[] }
    expect(report.rows[0]?.outcome).toBe('ERRO')
    expect(report.rows[0]?.message).toContain('importe os tutores antes')
  })

  it('o mesmo pet do mesmo dono não entra duas vezes', async () => {
    const linhas = [['529.982.247-25', 'Thor', 'Cão', '', 'Grande', '4 anos']]
    await aplicarPets(linhas)
    const segunda = await aplicarPets(linhas)

    expect((segunda.json() as { counts: { ignored: number } }).counts.ignored).toBe(1)
    expect(await withTenant(fixture.tenantId, (tx) => tx.pet.count())).toBe(1)
  })
})

/* ═══════════════════════════════════════════════════ Profissionais */

const CABECALHO_PROF = ['Nome', 'Função', 'Serviços']

async function aplicarProfissionais(linhas: string[][]) {
  const content = csv([CABECALHO_PROF, ...linhas])
  const analise = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/import/analyze',
    payload: { entity: 'PROFISSIONAL', fileName: 'equipe.csv', content },
  })
  const { mapping } = analise.json() as { mapping: Record<string, number> }

  return callApi({
    ...admin,
    method: 'POST',
    url: '/v1/import/apply',
    payload: {
      entity: 'PROFISSIONAL',
      fileName: 'equipe.csv',
      content,
      mapping,
      onExisting: 'IGNORAR',
    },
  })
}

describe('profissionais', () => {
  it('cria com a função traduzida do vocabulário do balcão e habilita nos serviços', async () => {
    await givenService(fixture, 'Banho')
    await givenService(fixture, 'Tosa higiênica')

    const resposta = await aplicarProfissionais([['Ana Paula', 'Tosadora', 'Banho/Tosa higiênica']])
    expect((resposta.json() as { counts: { created: number } }).counts.created).toBe(1)

    const profissional = await withTenant(fixture.tenantId, (tx) =>
      tx.professional.findFirstOrThrow({
        select: { displayName: true, roleKey: true, services: true },
      }),
    )
    expect(profissional.roleKey).toBe('GROOMER')
    expect(profissional.services).toHaveLength(2)
  })

  it('serviço que não existe no catálogo vira erro — não é criado de lado', async () => {
    /**
     * Ao contrário da raça: um serviço carrega preço e duração por porte, e inventar um
     * sem eles produziria um item que a agenda recusa na primeira tentativa de marcar.
     */
    await givenService(fixture, 'Banho')

    const resposta = await aplicarProfissionais([['Ana Paula', 'Banhista', 'Hidratação']])
    const report = resposta.json() as { rows: { outcome: string; message: string | null }[] }

    expect(report.rows[0]?.outcome).toBe('ERRO')
    expect(report.rows[0]?.message).toContain('não existe no catálogo')
  })

  it('avisa quando ninguém vai conseguir marcar com a pessoa importada', async () => {
    const resposta = await aplicarProfissionais([['Ana Paula', 'Banhista', '']])
    const report = resposta.json() as { rows: { outcome: string; message: string | null }[] }

    expect(report.rows[0]?.outcome).toBe('CRIADO')
    expect(report.rows[0]?.message).toContain('Sem serviço habilitado')
  })

  it('o nome é a chave: a segunda carga não cria um homônimo', async () => {
    await aplicarProfissionais([['Ana Paula', 'Banhista', '']])
    const segunda = await aplicarProfissionais([['ana paula', 'Banhista', '']])

    expect((segunda.json() as { counts: { ignored: number } }).counts.ignored).toBe(1)
    expect(await withTenant(fixture.tenantId, (tx) => tx.professional.count())).toBe(1)
  })
})

/* ═══════════════════════════════════════════════════ Agenda */

const CABECALHO_AGENDA = ['CPF do tutor', 'Pet', 'Profissional', 'Serviço', 'Data', 'Hora']

async function aplicarAgenda(linhas: string[][]) {
  const content = csv([CABECALHO_AGENDA, ...linhas])
  const analise = await callApi({
    ...admin,
    method: 'POST',
    url: '/v1/import/analyze',
    payload: { entity: 'AGENDA', fileName: 'agenda.csv', content },
  })
  const { mapping } = analise.json() as { mapping: Record<string, number> }

  return callApi({
    ...admin,
    method: 'POST',
    url: '/v1/import/apply',
    payload: { entity: 'AGENDA', fileName: 'agenda.csv', content, mapping, onExisting: 'IGNORAR' },
  })
}

describe('agenda', () => {
  beforeEach(async () => {
    await givenService(fixture, 'Banho')
    await aplicarTutores([['Ana Souza', '529.982.247-25', '(11) 98888-7777', '']])
    await aplicarPets([['529.982.247-25', 'Thor', 'Cão', '', 'Grande', '4 anos']])
    await aplicarProfissionais([['Ana Paula', 'Banhista', 'Banho']])

    const profissional = await withTenant(fixture.tenantId, (tx) =>
      tx.professional.findFirstOrThrow({ select: { id: true } }),
    )
    await givenSchedule(fixture, profissional.id)
  })

  it('marca o horário na hora de parede do estabelecimento', async () => {
    const resposta = await aplicarAgenda([
      ['529.982.247-25', 'Thor', 'Ana Paula', 'Banho', emDiasBR(7), '14:30'],
    ])

    expect((resposta.json() as { counts: { created: number } }).counts.created).toBe(1)

    const agendamento = await withTenant(fixture.tenantId, (tx) =>
      tx.appointment.findFirstOrThrow({
        select: { startsAt: true, source: true, totalCents: true },
      }),
    )
    // O fuso do fixture é UTC, então a hora de parede e o instante coincidem — o que se
    // verifica aqui é que a conversão não deslocou nada.
    expect(agendamento.startsAt.toISOString()).toContain('T14:30:00')
    expect(agendamento.source).toBe('STAFF')
    // O preço sai da tabela do porte, e não da planilha.
    expect(Number(agendamento.totalCents)).toBe(7000)
  })

  it('horário que já passou não entra', async () => {
    /**
     * Gravado como CONFIRMED, ele seria varrido pelo `no-show-sweeper` na hora seguinte
     * e viraria falta — com taxa, com mensagem e com um indicador que o petshop não
     * viveu.
     */
    const resposta = await aplicarAgenda([
      ['529.982.247-25', 'Thor', 'Ana Paula', 'Banho', emDiasBR(-3), '14:30'],
    ])

    const report = resposta.json() as {
      counts: { created: number; ignored: number }
      rows: { message: string | null }[]
    }
    expect(report.counts.created).toBe(0)
    expect(report.counts.ignored).toBe(1)
    expect(report.rows[0]?.message).toContain('sistema antigo')
  })

  it('fora da jornada, a linha volta com o motivo do balcão', async () => {
    const resposta = await aplicarAgenda([
      ['529.982.247-25', 'Thor', 'Ana Paula', 'Banho', emDiasBR(7), '23:00'],
    ])

    const report = resposta.json() as { rows: { outcome: string; message: string | null }[] }
    expect(report.rows[0]?.outcome).toBe('ERRO')
    expect(report.rows[0]?.message).toContain('não atende neste horário')
  })

  it('a hora da planilha é a do relógio do petshop, e não UTC', async () => {
    /**
     * O caso que só um fuso de verdade revela: "14:30" em São Paulo é 17:30Z. Montar o
     * instante como se a planilha falasse UTC deslocaria a agenda inteira em três horas —
     * o banho das 14:30 cairia às 11:30, dentro da jornada, e ninguém notaria até o
     * primeiro cliente aparecer na hora errada.
     *
     * O tenant deste caso é outro, com fuso de verdade. Trocar as variáveis do arquivo é
     * o que faz os atalhos acima (`aplicarTutores` e companhia) falarem com ele; quem as
     * devolve ao lugar é o `beforeEach`, que recria as duas a cada teste.
     */
    fixture = await givenTenant('America/Sao_Paulo')
    admin = asAdmin(fixture)

    await givenService(fixture, 'Banho')
    await aplicarTutores([['Ana Souza', '529.982.247-25', '(11) 98888-7777', '']])
    await aplicarPets([['529.982.247-25', 'Thor', 'Cão', '', 'Grande', '4 anos']])
    await aplicarProfissionais([['Ana Paula', 'Banhista', 'Banho']])

    const profissional = await withTenant(fixture.tenantId, (tx) =>
      tx.professional.findFirstOrThrow({ select: { id: true } }),
    )
    await givenSchedule(fixture, profissional.id)

    const resposta = await aplicarAgenda([
      ['529.982.247-25', 'Thor', 'Ana Paula', 'Banho', emDiasBR(7), '14:30'],
    ])
    expect((resposta.json() as { counts: { created: number } }).counts.created).toBe(1)

    const agendamento = await withTenant(fixture.tenantId, (tx) =>
      tx.appointment.findFirstOrThrow({ select: { startsAt: true } }),
    )
    expect(agendamento.startsAt.toISOString()).toContain('T17:30:00')
  })

  it('o mesmo horário não entra duas vezes', async () => {
    const linhas = [['529.982.247-25', 'Thor', 'Ana Paula', 'Banho', emDiasBR(7), '14:30']]
    await aplicarAgenda(linhas)
    const segunda = await aplicarAgenda(linhas)

    expect((segunda.json() as { counts: { ignored: number } }).counts.ignored).toBe(1)
    expect(await withTenant(fixture.tenantId, (tx) => tx.appointment.count())).toBe(1)
  })
})

/* ═══════════════════════════════════════════════════ Histórico e desfazer */

describe('lotes', () => {
  it('o lote guarda o que entrou, linha por linha', async () => {
    await aplicarTutores([
      ['Ana Souza', '529.982.247-25', '(11) 98888-7777', ''],
      ['Bia Lima', '111.111.111-11', '(11) 97777-6666', ''],
    ])

    const lista = await callApi({ ...admin, method: 'GET', url: '/v1/import/batches' })
    const { items } = lista.json() as { items: { id: string; entity: string }[] }
    expect(items).toHaveLength(1)

    const detalhe = await callApi({
      ...admin,
      method: 'GET',
      url: `/v1/import/batches/${items[0]?.id}`,
    })
    const lote = detalhe.json() as { rows: { lineNo: number; outcome: string }[] }
    expect(lote.rows.map((linha) => linha.outcome)).toEqual(['CRIADO', 'ERRO'])
  })

  it('desfazer um lote de tutores MANTÉM os tutores', async () => {
    /**
     * É a única entidade cuja sobra não é errada: a chave é o CPF, então reimportar o
     * arquivo corrigido converge por cima. Apagar um tutor alcançaria pet, agenda,
     * extrato e sessão do Portal.
     */
    await aplicarTutores([['Ana Souza', '529.982.247-25', '(11) 98888-7777', '']])
    const { items } = (
      await callApi({ ...admin, method: 'GET', url: '/v1/import/batches' })
    ).json() as { items: { id: string }[] }

    const resposta = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/import/batches/${items[0]?.id}/undo`,
    })

    expect(resposta.json()).toMatchObject({ removed: 0, keptTutors: 1 })
    expect(await withTenant(fixture.tenantId, (tx) => tx.tutor.count())).toBe(1)
  })

  it('desfazer um lote de pets apaga o que ele criou', async () => {
    await aplicarTutores([['Ana Souza', '529.982.247-25', '(11) 98888-7777', '']])
    await aplicarPets([['529.982.247-25', 'Thor', 'Cão', '', 'Grande', '4 anos']])

    const { items } = (
      await callApi({ ...admin, method: 'GET', url: '/v1/import/batches' })
    ).json() as { items: { id: string; entity: string }[] }
    const lotePets = items.find((item) => item.entity === 'PET')

    const resposta = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/import/batches/${lotePets?.id}/undo`,
    })

    expect(resposta.json()).toMatchObject({ removed: 1 })
    const pet = await withTenant(fixture.tenantId, (tx) =>
      tx.pet.findFirstOrThrow({ select: { deletedAt: true } }),
    )
    expect(pet.deletedAt).not.toBeNull()
  })

  it('o mesmo lote não se desfaz duas vezes', async () => {
    await aplicarTutores([['Ana Souza', '', '(11) 98888-7777', '']])
    const { items } = (
      await callApi({ ...admin, method: 'GET', url: '/v1/import/batches' })
    ).json() as { items: { id: string }[] }

    await callApi({ ...admin, method: 'POST', url: `/v1/import/batches/${items[0]?.id}/undo` })
    const segunda = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/import/batches/${items[0]?.id}/undo`,
    })

    expect(segunda.statusCode).toBe(409)
    expect(segunda.json()).toMatchObject({ code: 'ERR_IMPORT_004' })
  })

  it('desfazer pet que já tem horário marcado é recusado ANTES de apagar', async () => {
    await givenService(fixture, 'Banho')
    await aplicarTutores([['Ana Souza', '529.982.247-25', '(11) 98888-7777', '']])
    await aplicarPets([['529.982.247-25', 'Thor', 'Cão', '', 'Grande', '4 anos']])
    await aplicarProfissionais([['Ana Paula', 'Banhista', 'Banho']])

    const profissional = await withTenant(fixture.tenantId, (tx) =>
      tx.professional.findFirstOrThrow({ select: { id: true } }),
    )
    await givenSchedule(fixture, profissional.id)
    await aplicarAgenda([['529.982.247-25', 'Thor', 'Ana Paula', 'Banho', emDiasBR(7), '14:30']])

    const { items } = (
      await callApi({ ...admin, method: 'GET', url: '/v1/import/batches' })
    ).json() as { items: { id: string; entity: string }[] }
    const lotePets = items.find((item) => item.entity === 'PET')

    const resposta = await callApi({
      ...admin,
      method: 'POST',
      url: `/v1/import/batches/${lotePets?.id}/undo`,
    })

    expect(resposta.statusCode).toBe(409)
    expect((resposta.json() as { detail: string }).detail).toContain('agendamentos primeiro')

    const pet = await withTenant(fixture.tenantId, (tx) =>
      tx.pet.findFirstOrThrow({ select: { deletedAt: true } }),
    )
    expect(pet.deletedAt).toBeNull()
  })
})
