import { describe, expect, it } from 'vitest'
import { titleCase } from './text.js'

describe('titleCase', () => {
  it.each([
    ['Contas a receber', 'Contas a Receber'],
    ['Pagamento de tutor · Maria da Silva', 'Pagamento de Tutor · Maria da Silva'],
    ['O caixa está fechado', 'O Caixa Está Fechado'],
    ['Venda avulsa · ração 15 kg ×2', 'Venda Avulsa · Ração 15 kg ×2'],
    ['Pagamento via PIX no WhatsApp', 'Pagamento Via PIX no WhatsApp'],
    ['Onde você quer entrar?', 'Onde Você Quer Entrar?'],
    ['Tudo certo, bem-vindo!', 'Tudo Certo, Bem-vindo!'],
    ['Registro feito por engano?', 'Registro Feito por Engano?'],
    ['Excluir: a ficha do pet', 'Excluir: A Ficha do Pet'],
    ['Telefone (opcional)', 'Telefone (Opcional)'],
    ['E-mail e senha', 'E-mail e Senha'],
    ['', ''],
  ])('%s → %s', (entrada, saida) => {
    expect(titleCase(entrada)).toBe(saida)
  })

  it('é idempotente', () => {
    const uma = titleCase('Contas recebidas por dia')
    expect(titleCase(uma)).toBe(uma)
  })
})
