'use client'

import { useState, useTransition } from 'react'
import {
  WEEKDAYS,
  WEEKDAY_LABELS,
  type Branding,
  type BusinessHours,
  type TenantResponse,
  type TenantSettings,
  type Weekday,
} from '@petshop/shared-types'
import { Badge, Card, Field, FormError, Tabs } from '@/components/ui'
import {
  saveBrandingAction,
  saveHoursAction,
  saveIdentityAction,
  savePoliciesAction,
  type ActionResult,
} from './actions'

/**
 * Configurações do estabelecimento (MOD-IDENT-08, parcial).
 *
 * As mesmas decisões que o wizard coleta uma vez, agora editáveis a qualquer momento
 * — antes desta tela, mudar o horário de funcionamento exigia refazer um onboarding
 * que nem era reacessível.
 *
 * Cada aba salva sozinha, e não há um "Salvar tudo". Trocar a cor do portal e o
 * horário de sábado são decisões sem relação; uma falha na primeira não deve descartar
 * a segunda, e um PATCH por aba é exatamente o que a API expõe.
 */

const TIMEZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Cuiaba',
  'America/Belem',
  'America/Fortaleza',
  'America/Recife',
  'America/Bahia',
  'America/Rio_Branco',
  'America/Noronha',
]

const COLOR_PRESETS = [
  { color: '#E34A32', name: 'Coral' },
  { color: '#0F766E', name: 'Verde-mar' },
  { color: '#1D4ED8', name: 'Azul' },
  { color: '#7C3AED', name: 'Roxo' },
  { color: '#B45309', name: 'Âmbar' },
  { color: '#171719', name: 'Grafite' },
]

const TABS = [
  { id: 'dados', label: 'Dados' },
  { id: 'horario', label: 'Horário' },
  { id: 'politicas', label: 'Políticas' },
  { id: 'visual', label: 'Visual' },
]

export interface SettingsFormProps {
  tenant: TenantResponse
  settings: TenantSettings
  /** `tenant:configure`. Sem ela a tela é de leitura — o backend recusaria de todo jeito. */
  canEdit: boolean
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/** Estado de salvamento compartilhado pelas abas. */
interface SaveState {
  pending: boolean
  error: string | null
  fieldErrors: Record<string, string>
  savedAt: number | null
}

const IDLE: SaveState = { pending: false, error: null, fieldErrors: {}, savedAt: null }

export function SettingsForm({ tenant, settings, canEdit }: SettingsFormProps) {
  const [active, setActive] = useState('dados')
  const [state, setState] = useState<SaveState>(IDLE)
  const [, startTransition] = useTransition()

  /**
   * Roda a ação da aba corrente. O resultado é descartado de propósito: o servidor já
   * revalidou o caminho, e reaproveitar o payload aqui só criaria uma segunda fonte de
   * verdade para o mesmo dado.
   */
  function run(action: () => Promise<ActionResult<unknown>>) {
    setState({ ...IDLE, pending: true })

    startTransition(async () => {
      const result = await action()
      setState(
        result.ok
          ? { ...IDLE, savedAt: Date.now() }
          : { ...IDLE, error: result.message, fieldErrors: result.fieldErrors },
      )
    })
  }

  /** Troca de aba zera o aviso: "Salvo" de outra seção confundiria. */
  function selectTab(id: string) {
    setState(IDLE)
    setActive(id)
  }

  const shared = { state, canEdit, run }

  return (
    <div>
      {!canEdit && (
        <div className="mb-6">
          <Badge>Somente leitura · seu perfil não altera as configurações</Badge>
        </div>
      )}

      <Tabs tabs={TABS} active={active} onSelect={selectTab} />

      <div className="mt-6">
        <FormError message={state.error} />
      </div>

      <div className="mt-6">
        {active === 'dados' && <IdentityPanel {...shared} tenant={tenant} />}
        {active === 'horario' && <HoursPanel {...shared} settings={settings} />}
        {active === 'politicas' && <PoliciesPanel {...shared} settings={settings} />}
        {active === 'visual' && <BrandingPanel {...shared} branding={settings.branding} />}
      </div>
    </div>
  )
}

// ─── Peças compartilhadas ────────────────────────────────────────────────────

interface PanelProps {
  state: SaveState
  canEdit: boolean
  run: (action: () => Promise<ActionResult<unknown>>) => void
}

function SaveButton({
  state,
  canEdit,
  disabled = false,
  onClick,
}: PanelProps & { disabled?: boolean; onClick: () => void }) {
  if (!canEdit) return null

  return (
    <div className="mt-8 flex items-center gap-3">
      <button
        type="button"
        className="btn btn-primary"
        disabled={state.pending || disabled}
        onClick={onClick}
      >
        {state.pending ? 'Salvando…' : 'Salvar alterações'}
      </button>
      {state.savedAt !== null && (
        <span className="text-sm text-success" role="status">
          Salvo
        </span>
      )}
    </div>
  )
}

// ─── Dados do estabelecimento ────────────────────────────────────────────────

function IdentityPanel({ state, canEdit, run, tenant }: PanelProps & { tenant: TenantResponse }) {
  const [name, setName] = useState(tenant.name)
  const [legalName, setLegalName] = useState(tenant.legalName ?? '')
  const [cnpj, setCnpj] = useState(tenant.cnpj ?? '')

  const digits = cnpj.replace(/\D/g, '')
  const cnpjInvalid = digits.length > 0 && digits.length !== 14

  return (
    <Card>
      <h2 className="text-xl font-semibold">Dados do estabelecimento</h2>
      <p className="hint mt-2">
        Aparecem para seus tutores no portal e nos documentos que o sistema emite.
      </p>

      <div className="mt-8 space-y-5">
        <Field label="Nome do petshop" htmlFor="name" error={state.fieldErrors.name}>
          <input
            id="name"
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            minLength={2}
            maxLength={120}
            disabled={!canEdit}
            aria-invalid={Boolean(state.fieldErrors.name)}
          />
        </Field>

        <Field
          label="Razão social"
          htmlFor="legalName"
          error={state.fieldErrors.legalName}
          hint="Opcional. Aparece nos recibos."
        >
          <input
            id="legalName"
            className="field"
            value={legalName}
            onChange={(event) => setLegalName(event.target.value)}
            maxLength={160}
            disabled={!canEdit}
          />
        </Field>

        <Field
          label="CNPJ"
          htmlFor="cnpj"
          error={state.fieldErrors.cnpj ?? (cnpjInvalid ? 'O CNPJ tem 14 dígitos.' : undefined)}
          hint="Opcional. Guardado criptografado."
        >
          <input
            id="cnpj"
            className="field"
            value={cnpj}
            onChange={(event) => setCnpj(event.target.value)}
            placeholder="00.000.000/0000-00"
            inputMode="numeric"
            disabled={!canEdit}
            aria-invalid={Boolean(state.fieldErrors.cnpj) || cnpjInvalid}
          />
        </Field>

        {/*
          O endereço do portal é definitivo: vira subdomínio, entra em link que o tutor
          já salvou e em QR code impresso. Trocar quebraria tudo isso em silêncio.
        */}
        <Field label="Endereço do portal" htmlFor="slug" hint="Definido no cadastro e permanente.">
          <div className="flex items-center gap-2">
            <input id="slug" className="field" value={tenant.slug} readOnly disabled />
            <span className="hint whitespace-nowrap">.petshopai.app</span>
          </div>
        </Field>
      </div>

      <SaveButton
        state={state}
        canEdit={canEdit}
        run={run}
        disabled={cnpjInvalid || name.trim().length < 2}
        onClick={() =>
          run(() =>
            saveIdentityAction({
              name: name.trim(),
              legalName: legalName.trim() || null,
              cnpj: digits || null,
            }),
          )
        }
      />
    </Card>
  )
}

// ─── Horário de funcionamento ────────────────────────────────────────────────

function HoursPanel({ state, canEdit, run, settings }: PanelProps & { settings: TenantSettings }) {
  const [timezone, setTimezone] = useState(settings.timezone)
  const [hours, setHours] = useState<BusinessHours>(settings.businessHours)

  const invalidDays = WEEKDAYS.filter((day) => {
    const value = hours[day]
    return !value.closed && toMinutes(value.closesAt) <= toMinutes(value.opensAt)
  })

  function updateDay(day: Weekday, patch: Partial<BusinessHours[Weekday]>) {
    setHours((current) => ({ ...current, [day]: { ...current[day], ...patch } }))
  }

  return (
    <Card>
      <h2 className="text-xl font-semibold">Horário de funcionamento</h2>
      <p className="hint mt-2">
        A agenda usa esses horários para oferecer os encaixes disponíveis aos tutores.
      </p>

      <div className="mt-8 space-y-5">
        <Field label="Fuso horário" htmlFor="timezone" error={state.fieldErrors.timezone}>
          <select
            id="timezone"
            className="field"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            disabled={!canEdit}
          >
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace('America/', '').replace('_', ' ')}
              </option>
            ))}
          </select>
        </Field>

        <fieldset>
          <legend className="label">Dias e horários</legend>
          <div className="space-y-2">
            {WEEKDAYS.map((day) => {
              const value = hours[day]
              const invalid = invalidDays.includes(day)

              return (
                <div
                  key={day}
                  className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3"
                >
                  <label className="flex w-32 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!value.closed}
                      onChange={(event) => updateDay(day, { closed: !event.target.checked })}
                      aria-label={`Abrir ${WEEKDAY_LABELS[day]}`}
                      disabled={!canEdit}
                    />
                    <span className={value.closed ? 'text-subtle' : 'font-medium'}>
                      {WEEKDAY_LABELS[day]}
                    </span>
                  </label>

                  {value.closed ? (
                    <span className="hint">Fechado</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        className="field w-32"
                        value={value.opensAt}
                        onChange={(event) => updateDay(day, { opensAt: event.target.value })}
                        aria-label={`Abertura ${WEEKDAY_LABELS[day]}`}
                        aria-invalid={invalid}
                        disabled={!canEdit}
                      />
                      <span className="hint">às</span>
                      <input
                        type="time"
                        className="field w-32"
                        value={value.closesAt}
                        onChange={(event) => updateDay(day, { closesAt: event.target.value })}
                        aria-label={`Fechamento ${WEEKDAY_LABELS[day]}`}
                        aria-invalid={invalid}
                        disabled={!canEdit}
                      />
                    </div>
                  )}

                  {invalid && (
                    <p className="error-text w-full" role="alert">
                      Horário de fechamento deve ser posterior ao de abertura
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </fieldset>
      </div>

      <SaveButton
        state={state}
        canEdit={canEdit}
        run={run}
        disabled={invalidDays.length > 0}
        onClick={() => run(() => saveHoursAction({ timezone, businessHours: hours }))}
      />
    </Card>
  )
}

// ─── Políticas de agenda ─────────────────────────────────────────────────────

function PoliciesPanel({
  state,
  canEdit,
  run,
  settings,
}: PanelProps & { settings: TenantSettings }) {
  const [cancellation, setCancellation] = useState(settings.cancellationWindowHours)
  const [notice, setNotice] = useState(settings.minBookingNoticeHours)
  const [noShowFee, setNoShowFee] = useState(settings.noShowFeePercent)
  const [onlineBooking, setOnlineBooking] = useState(settings.onlineBookingEnabled)
  const [overbooking, setOverbooking] = useState(settings.allowOverbooking)

  return (
    <Card>
      <h2 className="text-xl font-semibold">Políticas de agendamento</h2>
      <p className="hint mt-2">
        Valem para o portal do tutor e para o agente de IA no WhatsApp. Mudanças só
        afetam agendamentos novos — o que já está marcado mantém a regra do momento em
        que foi feito.
      </p>

      <div className="mt-8 space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Cancelamento sem custo até"
            htmlFor="cancellation"
            error={state.fieldErrors.cancellationWindowHours}
            hint="Abaixo disso conta como falta."
          >
            <div className="flex items-center gap-2">
              <input
                id="cancellation"
                type="number"
                className="field"
                min={0}
                max={72}
                value={cancellation}
                onChange={(event) => setCancellation(Number(event.target.value))}
                disabled={!canEdit}
              />
              <span className="hint">horas antes</span>
            </div>
          </Field>

          <Field
            label="Antecedência mínima"
            htmlFor="notice"
            error={state.fieldErrors.minBookingNoticeHours}
            hint="Para o tutor agendar pelo portal."
          >
            <div className="flex items-center gap-2">
              <input
                id="notice"
                type="number"
                className="field"
                min={0}
                max={168}
                value={notice}
                onChange={(event) => setNotice(Number(event.target.value))}
                disabled={!canEdit}
              />
              <span className="hint">horas</span>
            </div>
          </Field>
        </div>

        <Field
          label="Cobrança por falta"
          htmlFor="noShowFee"
          error={state.fieldErrors.noShowFeePercent}
          hint="Percentual do serviço lançado na conta em caso de falta. Zero desliga a cobrança."
        >
          <div className="flex items-center gap-2">
            <input
              id="noShowFee"
              type="number"
              className="field"
              min={0}
              max={100}
              value={noShowFee}
              onChange={(event) => setNoShowFee(Number(event.target.value))}
              disabled={!canEdit}
            />
            <span className="hint">%</span>
          </div>
        </Field>

        <div className="space-y-3 rounded-2xl border border-line bg-card px-5 py-4">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={onlineBooking}
              onChange={(event) => setOnlineBooking(event.target.checked)}
              disabled={!canEdit}
            />
            <span>
              <span className="font-medium">Agendamento online</span>
              <span className="hint block">
                O tutor marca sozinho pelo portal. Desligado, só a recepção agenda.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={overbooking}
              onChange={(event) => setOverbooking(event.target.checked)}
              disabled={!canEdit}
            />
            <span>
              <span className="font-medium">Permitir encaixe acima da capacidade</span>
              <span className="hint block">
                A agenda aceita marcar além dos profissionais disponíveis no horário.
              </span>
            </span>
          </label>
        </div>
      </div>

      <SaveButton
        state={state}
        canEdit={canEdit}
        run={run}
        onClick={() =>
          run(() =>
            savePoliciesAction({
              cancellationWindowHours: cancellation,
              minBookingNoticeHours: notice,
              noShowFeePercent: noShowFee,
              onlineBookingEnabled: onlineBooking,
              allowOverbooking: overbooking,
            }),
          )
        }
      />
    </Card>
  )
}

// ─── Identidade visual ───────────────────────────────────────────────────────

function BrandingPanel({ state, canEdit, run, branding }: PanelProps & { branding: Branding }) {
  const [primaryColor, setPrimaryColor] = useState(branding.primaryColor)

  const validColor = /^#[0-9a-fA-F]{6}$/.test(primaryColor)

  return (
    <Card>
      <h2 className="text-xl font-semibold">Identidade visual</h2>
      <p className="hint mt-2">
        A cor aparece no portal do tutor e no site do seu petshop.
      </p>

      <div className="mt-8 space-y-5">
        <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Cor principal">
          {COLOR_PRESETS.map((preset) => (
            <button
              key={preset.color}
              type="button"
              role="radio"
              aria-checked={primaryColor.toUpperCase() === preset.color}
              aria-label={preset.name}
              disabled={!canEdit}
              onClick={() => setPrimaryColor(preset.color)}
              className={`h-12 w-12 rounded-full transition ${
                primaryColor.toUpperCase() === preset.color
                  ? 'ring-2 ring-ink ring-offset-2'
                  : 'hover:scale-105'
              }`}
              style={{ backgroundColor: preset.color }}
            />
          ))}
        </div>

        <Field
          label="Ou informe a cor exata"
          htmlFor="primaryColor"
          error={
            state.fieldErrors.primaryColor ??
            (validColor ? undefined : 'Use uma cor no formato #RRGGBB.')
          }
        >
          <div className="flex items-center gap-3">
            <input
              id="primaryColor"
              className="field"
              value={primaryColor}
              onChange={(event) => setPrimaryColor(event.target.value.toUpperCase())}
              placeholder="#E34A32"
              maxLength={7}
              disabled={!canEdit}
              aria-invalid={Boolean(state.fieldErrors.primaryColor) || !validColor}
            />
            <span
              className="h-11 w-11 shrink-0 rounded-full border border-line"
              style={{ backgroundColor: validColor ? primaryColor : 'transparent' }}
              aria-hidden="true"
            />
          </div>
        </Field>

        {/* Prévia: ver a cor aplicada vale mais do que o código hexadecimal. */}
        <div className="rounded-2xl border border-line p-5">
          <p className="hint mb-3">Prévia</p>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="btn pill px-5 py-2.5 text-sm font-medium text-white"
              style={{ backgroundColor: validColor ? primaryColor : undefined }}
            >
              Agendar banho
            </span>
            <span
              className="pill px-3 py-1 text-xs font-medium"
              style={
                validColor
                  ? { backgroundColor: `${primaryColor}1a`, color: primaryColor }
                  : undefined
              }
            >
              Confirmado
            </span>
          </div>
        </div>
      </div>

      <SaveButton
        state={state}
        canEdit={canEdit}
        run={run}
        disabled={!validColor}
        onClick={() => run(() => saveBrandingAction({ primaryColor }))}
      />
    </Card>
  )
}
