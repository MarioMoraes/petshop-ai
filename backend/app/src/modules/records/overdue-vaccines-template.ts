import { formatPhoneBR, titleCase } from '@petshop/shared-types'
import type { OverdueVaccinesList, OverdueVaccinesListPet } from './overdue-vaccines.js'
import { OVERDUE_VACCINES_MAX_PETS } from './overdue-vaccines.js'
import { escapeHtml } from './pdf-port.js'

/**
 * O HTML da lista de pets com vacina atrasada — o detalhe do cartão do Início.
 *
 * A mesma escola de `inventory/position-template.ts`: função pura, sem engine de
 * template, e **todo campo livre passa por `escapeHtml`** — nome de pet, de tutor e de
 * vacina "Outra" são digitados, e o Gotenberg roda um Chromium de verdade.
 *
 * É a folha de quem vai ligar: cada pet aparece uma vez, com o tutor e o telefone ao
 * lado, e as vacinas que ele deve uma abaixo da outra — o pet que deve duas vacinas é
 * uma ligação só.
 */

export function renderOverdueVaccinesHtml(list: OverdueVaccinesList): string {
  const corpo =
    list.pets.length === 0
      ? `<div class="vazio">Nenhum pet ativo com vacina atrasada.</div>`
      : `
  <div class="resumo">
    <div>
      <div class="rotulo">Pets com vacina atrasada</div>
      <div class="valor">${list.truncated ? `Mais de ${OVERDUE_VACCINES_MAX_PETS}` : list.pets.length}</div>
    </div>
    <div>
      <div class="rotulo">Doses atrasadas</div>
      <div class="valor">${list.doses}</div>
    </div>
  </div>

  ${
    list.truncated
      ? `<p class="aviso">A lista mostra os ${OVERDUE_VACCINES_MAX_PETS} pets com o atraso mais
         antigo. Os demais aparecem conforme estes forem regularizados.</p>`
      : ''
  }

  <table>
    <thead>
      <tr>
        <th class="nome">Pet</th>
        <th class="nome">Tutor</th>
        <th class="num">Telefone</th>
        <th class="vacinas">Vacina atrasada</th>
        <th class="num">Venceu em</th>
        <th class="num">Atraso</th>
      </tr>
    </thead>
    <tbody>${list.pets.map(petRow).join('')}</tbody>
  </table>`

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Vacinas Atrasadas</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 10pt; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
           border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  h1 { font-size: 14pt; margin: 0; }
  header .sub { margin: 3px 0 0; color: #555; font-size: 10pt; }
  header .periodo { text-align: right; color: #555; }
  header .periodo strong { display: block; color: #1a1a1a; font-size: 11pt; }

  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-top: 18px; }
  th { text-align: left; font-size: 8.5pt; color: #555; text-transform: uppercase;
       letter-spacing: 0.04em; border-bottom: 1px solid #ddd; padding: 5px 6px; }
  td { padding: 6px; vertical-align: top; }
  /* O fio separa pets, e não vacinas: as do mesmo pet ficam juntas. */
  tr.primeira td { border-top: 1px solid #eee; }
  tr.seguinte td { padding-top: 0; }
  td.num, th.num { text-align: right; white-space: nowrap; width: 1%; }
  td.nome, th.nome { min-width: 9rem; }
  td.vacinas { min-width: 10rem; }
  .pet { font-weight: bold; }
  .meta { color: #555; font-size: 8.5pt; }
  .sem { color: #999; }
  .atraso { color: #b91c1c; font-weight: bold; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  tbody tr:last-child td { border-bottom: 1px solid #eee; }

  .resumo { display: flex; gap: 10px; margin-top: 14px; }
  .resumo div { flex: 1; background: #f4f4f2; border-radius: 6px; padding: 9px 11px; }
  .resumo .rotulo { font-size: 8pt; color: #555; text-transform: uppercase;
                    letter-spacing: 0.05em; }
  .resumo .valor { font-size: 13pt; font-weight: bold; margin-top: 2px; }

  .vazio { margin-top: 22px; padding: 22px; background: #f4f4f2; border-radius: 6px;
           text-align: center; color: #555; }
  .aviso { margin-top: 10px; padding: 9px 11px; border-left: 3px solid #b45309;
           background: #fdf6ec; color: #7c4a03; font-size: 9pt; }

  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #ddd;
           font-size: 8.5pt; color: #555; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(list.tenantName)}</h1>
      <p class="sub">${escapeHtml(titleCase('Pets com vacina atrasada'))}</p>
    </div>
    <div class="periodo">
      <strong>Posição em ${formatDateOnly(list.today)}</strong>
      Emitido em ${escapeHtml(formatDateTime(list.generatedAt, list.timezone))}
    </div>
  </header>
  ${corpo}
  <footer>
    Documento gerado pelo PetShop AI para uso interno. Conta a dose mais recente de cada
    vacina, em pets ativos; a dose que vence hoje ainda não está atrasada. Contém dados
    pessoais dos tutores — não compartilhe fora da equipe.
  </footer>
</body>
</html>`
}

function petRow(pet: OverdueVaccinesListPet): string {
  const raca = [pet.species, pet.breed].filter(Boolean).join(' · ')
  const span = pet.vaccines.length

  // Uma linha de tabela por vacina, e o pet, o tutor e o telefone ocupando as linhas
  // dele: empilhar as vacinas numa célula só desalinhava a data da seguinte sempre que
  // um nome longo ("Gripe Canina (Tosse dos Canis)") quebrava em duas linhas.
  return pet.vaccines
    .map((vaccine, index) => {
      const head =
        index === 0
          ? `
        <td class="nome" rowspan="${span}"><div class="pet">${escapeHtml(pet.petName)}</div><div class="meta">${escapeHtml(raca)}</div></td>
        <td class="nome" rowspan="${span}">${pet.tutorName ? escapeHtml(pet.tutorName) : '<span class="sem">Sem tutor principal</span>'}</td>
        <td class="num" rowspan="${span}">${pet.phone ? escapeHtml(formatPhoneBR(pet.phone)) : '<span class="sem">—</span>'}</td>`
          : ''
      return `
      <tr class="${index === 0 ? 'primeira' : 'seguinte'}">${head}
        <td class="vacinas">${escapeHtml(vaccine.label)}</td>
        <td class="num">${formatDateOnly(vaccine.nextDoseAt)}</td>
        <td class="num atraso">${formatDays(vaccine.daysOverdue)}</td>
      </tr>`
    })
    .join('')
}

/** "1 dia", "45 dias". */
function formatDays(days: number): string {
  return `${days.toLocaleString('pt-BR')} ${days === 1 ? 'dia' : 'dias'}`
}

function formatDateOnly(isoDate: string): string {
  const [year, month, day] = isoDate.split('-')
  return `${day}/${month}/${year}`
}

function formatDateTime(isoDateTime: string, timeZone: string): string {
  return new Date(isoDateTime).toLocaleString('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  })
}
