import {
  ALLERGY_TYPE_LABELS,
  RISK_TEMPERAMENTS,
  SEVERITY_LABELS,
  TEMPERAMENT_CONTEXT_LABELS,
  TEMPERAMENT_LABELS,
  VACCINATION_STATUS_LABELS,
  formatPhoneBR,
  type TemperamentContext,
} from '@petshop/shared-types'
import type { PetSheet } from './pet-sheet.js'
import { escapeHtml } from './pdf-port.js'

/**
 * O HTML da ficha do pet (MOD-PET-11) — uma folha A4 para a sala de banho e tosa.
 *
 * A ordem é a de quem pega o pet no colo: **o que pode machucar vem primeiro** (alergia,
 * temperamento, alerta), a identificação em volta, as vacinas depois, e no pé um quadro
 * em branco para anotar à mão o que aconteceu no atendimento. Mesma escola dos outros
 * PDFs do prontuário: função pura, e todo campo digitado passa por `escapeHtml`.
 */
export function renderPetSheetHtml(sheet: PetSheet): string {
  const { pet, safety, vaccines } = sheet
  const alergias = safety.allergies.filter((allergy) => allergy.active)
  const alertas = safety.medicalAlerts.filter((alert) => alert.active)
  const temperamento = safety.temperament.current
  const risco =
    temperamento !== null &&
    (RISK_TEMPERAMENTS as readonly string[]).includes(temperamento.classification)

  const identificacao = [
    pet.species,
    pet.breed,
    pet.size,
    pet.coat,
    pet.sex === 'MALE' ? 'Macho' : pet.sex === 'FEMALE' ? 'Fêmea' : null,
  ]
    .filter((item): item is string => Boolean(item))
    .map(escapeHtml)
    .join(' · ')

  const semNada = alergias.length === 0 && alertas.length === 0 && !risco

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Ficha do Pet</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 10.5pt; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
           border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  h1 { font-size: 22pt; margin: 0; }
  header .sub { margin: 4px 0 0; color: #444; }
  header .casa { text-align: right; color: #555; font-size: 9pt; }
  header .casa strong { display: block; color: #1a1a1a; font-size: 11pt; }

  .fatos { display: flex; gap: 10px; margin-top: 12px; }
  .fatos div { flex: 1; background: #f4f4f2; border-radius: 6px; padding: 8px 10px; }
  .rotulo { font-size: 8pt; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
  .valor { font-size: 12pt; font-weight: bold; margin-top: 2px; }

  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.05em; margin: 18px 0 6px; }
  .perigo { border: 2px solid #b91c1c; border-radius: 6px; padding: 10px 12px; }
  .perigo h2 { color: #b91c1c; margin-top: 0; }
  .ok { border: 1px solid #ddd; border-radius: 6px; padding: 10px 12px; color: #444; }
  ul { margin: 0; padding-left: 18px; }
  li { margin: 4px 0; }
  .sev { font-weight: bold; }
  .meta { color: #555; font-size: 9pt; }
  .tag { display: inline-block; border: 1px solid #b91c1c; color: #b91c1c; border-radius: 4px;
         padding: 1px 6px; font-size: 9pt; font-weight: bold; margin-right: 4px; }

  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th { text-align: left; font-size: 8.5pt; color: #555; text-transform: uppercase;
       border-bottom: 1px solid #ddd; padding: 4px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #eee; }
  .atrasada { color: #b91c1c; font-weight: bold; }

  .anotar { margin-top: 6px; border: 1px solid #bbb; border-radius: 6px; height: 150px; }
  footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #ddd;
           font-size: 8.5pt; color: #555; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(pet.name)}</h1>
      <p class="sub">${identificacao}</p>
    </div>
    <div class="casa">
      <strong>${escapeHtml(sheet.tenantName)}</strong>
      Impressa em ${escapeHtml(formatDateTime(sheet.generatedAt, sheet.timezone))}
    </div>
  </header>

  <div class="fatos">
    <div><div class="rotulo">Idade</div><div class="valor">${escapeHtml(pet.ageLabel ?? '—')}</div></div>
    <div><div class="rotulo">Peso</div><div class="valor">${
      pet.weightKg === null ? '—' : `${pet.weightKg.toLocaleString('pt-BR')} kg`
    }</div></div>
    ${
      sheet.tutor
        ? `<div><div class="rotulo">Tutor</div><div class="valor">${escapeHtml(sheet.tutor.name)}</div>
           ${sheet.tutor.phone ? `<div class="meta">${escapeHtml(formatPhoneBR(sheet.tutor.phone))}</div>` : ''}</div>`
        : ''
    }
  </div>

  ${
    semNada
      ? `<h2>Segurança</h2><div class="ok">Nenhuma alergia, alerta ou temperamento de risco registrado.${
          temperamento
            ? ` Temperamento: ${escapeHtml(TEMPERAMENT_LABELS[temperamento.classification])}.`
            : ''
        }</div>`
      : `<div class="perigo" style="margin-top:18px">
    <h2>Atenção antes de manusear</h2>
    ${temperamento ? temperamentoHtml(temperamento) : ''}
    ${
      alergias.length > 0
        ? `<p class="rotulo" style="margin:10px 0 4px">Alergias</p><ul>${alergias
            .map(
              (allergy) =>
                `<li><span class="sev">${escapeHtml(allergy.label)}</span> — ${escapeHtml(
                  ALLERGY_TYPE_LABELS[allergy.type],
                )}, ${escapeHtml(SEVERITY_LABELS[allergy.severity])}${
                  allergy.reaction ? `<div class="meta">${escapeHtml(allergy.reaction)}</div>` : ''
                }${
                  allergy.blocksProducts.length > 0
                    ? `<div class="meta">Não usar: ${allergy.blocksProducts.map(escapeHtml).join(', ')}</div>`
                    : ''
                }</li>`,
            )
            .join('')}</ul>`
        : ''
    }
    ${
      alertas.length > 0
        ? `<p class="rotulo" style="margin:10px 0 4px">Alertas médicos</p><ul>${alertas
            .map(
              (alert) =>
                `<li><span class="sev">${escapeHtml(alert.condition)}</span> — ${escapeHtml(
                  SEVERITY_LABELS[alert.severity],
                )}${alert.instructions ? `<div class="meta">${escapeHtml(alert.instructions)}</div>` : ''}</li>`,
            )
            .join('')}</ul>`
        : ''
    }
  </div>`
  }

  <h2>Vacinas</h2>
  ${
    vaccines.current.length === 0
      ? `<div class="ok">Nenhuma vacina registrada.</div>`
      : `<table>
    <thead><tr><th>Vacina</th><th>Aplicada em</th><th>Próxima dose</th></tr></thead>
    <tbody>${vaccines.current
      .map((dose) => {
        const atrasada = dose.nextDoseAt !== null && dose.nextDoseAt < vaccines.today
        return `<tr><td>${escapeHtml(dose.vaccineLabel)}</td><td>${formatDateOnly(dose.appliedAt)}</td><td${
          atrasada ? ' class="atrasada"' : ''
        }>${dose.nextDoseAt ? formatDateOnly(dose.nextDoseAt) : '—'}${atrasada ? ' (atrasada)' : ''}</td></tr>`
      })
      .join('')}</tbody>
  </table>
  <p class="meta">Situação da carteira: ${escapeHtml(VACCINATION_STATUS_LABELS[vaccines.status])}</p>`
  }

  <h2>Anotações do atendimento</h2>
  <div class="anotar"></div>

  <footer>
    Ficha gerada pelo PetShop AI para uso interno da equipe. Reflete o prontuário no momento
    da impressão — confira a tela antes de um procedimento se a folha for de outro dia.
  </footer>
</body>
</html>`
}

function temperamentoHtml(
  temperament: NonNullable<PetSheet['safety']['temperament']['current']>,
): string {
  const cuidados = [
    temperament.requiresMuzzle ? '<span class="tag">Usar focinheira</span>' : '',
    temperament.requiresTwoHandlers ? '<span class="tag">Duas pessoas</span>' : '',
  ].join('')
  const contextos = temperament.contexts
    .map((context) => TEMPERAMENT_CONTEXT_LABELS[context as TemperamentContext] ?? context)
    .map(escapeHtml)
    .join(', ')
  return `<p style="margin:0"><span class="rotulo">Temperamento</span><br>
    <span class="valor">${escapeHtml(TEMPERAMENT_LABELS[temperament.classification])}</span> ${cuidados}</p>
    ${contextos ? `<div class="meta">Reage a: ${contextos}</div>` : ''}
    ${temperament.notes ? `<div class="meta">${escapeHtml(temperament.notes)}</div>` : ''}`
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
