'use client'

import { useState, useTransition } from 'react'
import {
  WEEKDAYS,
  WEEKDAY_LABELS,
  formatCEP,
  formatPhoneBR,
  type Branding,
  type BusinessHours,
  type DeletionRequestResponse,
  type Species,
  type TenantAddress,
  type TenantResponse,
  type TenantSettings,
  type Weekday,
} from '@petshop/shared-types'
import { Badge, Card, Choice, Field, FormError, SectionHead, Tabs } from '@/components/ui'
import {
  CalendarIcon,
  IdCardIcon,
  MapPinIcon,
  PaletteIcon,
  ShieldCheckIcon,
} from '@/components/icons'
import {
  lookupCepAction,
  saveBrandingAction,
  saveContactAction,
  saveHoursAction,
  saveIdentityAction,
  savePoliciesAction,
  type ActionResult,
} from './actions'
import { BreedCatalog } from './breed-catalog'
import { Privacidade } from './privacidade'

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

/** MOD-PET-03: a lista de raças é configuração do estabelecimento, não do atendimento. */
const CATALOG_TAB = { id: 'racas', label: 'Raças' }

/**
 * MOD-PORTAL-09: a fila de pedidos de exclusão de dados.
 *
 * Aqui e não numa tela própria porque é configuração do estabelecimento — decisão sobre a
 * base de cadastro, não operação de balcão. E porque é rara: uma entrada de menu que fica
 * vazia meses a fio custa mais atenção, todo dia, do que a fila custa quando enche. Quem
 * avisa que ela encheu é o sino da topbar.
 */
const PRIVACY_TAB = { id: 'privacidade', label: 'Privacidade' }

export interface SettingsFormProps {
  tenant: TenantResponse
  settings: TenantSettings
  /** Espécies do catálogo, para a aba de raças. Vazio quando ela não é exibida. */
  species: Species[]
  /** `tenant:configure`. Sem ela a tela é de leitura — o backend recusaria de todo jeito. */
  /** `.meupetshop.com.br` — resolvido no servidor; ver `lib/domain.ts`. */
  hostSuffix: string
  canEdit: boolean
  /** `pet:manage_catalog`: só o administrador mexe no catálogo de raças. */
  canManageCatalog: boolean
  /**
   * A fila de exclusão. Vazia quando o perfil não tem `tutor:delete` — e nesse caso a aba
   * também não é desenhada, porque ela é uma lista de decisões que a pessoa não pode tomar.
   */
  deletionRequests: DeletionRequestResponse[]
  canResolveDeletions: boolean
  /**
   * A aba que abre, quando a URL a nomeia.
   *
   * O sino da topbar aponta para `/configuracoes?aba=privacidade`, e sem isto o clique
   * cairia na aba "Dados" — o contador prometeria um destino e entregaria outro.
   */
  abaInicial?: string
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

export function SettingsForm({
  tenant,
  settings,
  species,
  hostSuffix,
  canEdit,
  canManageCatalog,
  deletionRequests,
  canResolveDeletions,
  abaInicial,
}: SettingsFormProps) {
  const [active, setActive] = useState(abaInicial ?? 'dados')
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

      <Tabs
        tabs={[
          ...TABS,
          ...(canManageCatalog ? [CATALOG_TAB] : []),
          ...(canResolveDeletions ? [PRIVACY_TAB] : []),
        ]}
        active={active}
        onSelect={selectTab}
      />

      <div className="mt-6">
        <FormError message={state.error} />
      </div>

      <div className="mt-6">
        {active === 'dados' && (
          <div className="space-y-6">
            <IdentityPanel {...shared} tenant={tenant} hostSuffix={hostSuffix} />
            <ContactPanel {...shared} settings={settings} />
          </div>
        )}
        {active === 'horario' && <HoursPanel {...shared} settings={settings} />}
        {active === 'politicas' && <PoliciesPanel {...shared} settings={settings} />}
        {active === 'visual' && <BrandingPanel {...shared} branding={settings.branding} />}
        {/*
          A aba de raças não usa o `shared`: ela salva item a item, com o resultado
          na própria linha, e não tem um "Salvar" no rodapé como as outras.
        */}
        {active === 'racas' && <BreedCatalog species={species} canManage={canManageCatalog} />}
        {/* Também sem o `shared`: cada pedido é respondido na própria linha. */}
        {active === 'privacidade' && <Privacidade pedidos={deletionRequests} />}
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
    <div className="mt-8 flex items-center justify-end gap-3">
      {state.savedAt !== null && (
        <span className="text-sm text-success" role="status">
          Salvo
        </span>
      )}
      <button
        type="button"
        className="btn btn-primary"
        disabled={state.pending || disabled}
        onClick={onClick}
      >
        {state.pending ? 'Salvando…' : 'Salvar alterações'}
      </button>
    </div>
  )
}

// ─── Dados do estabelecimento ────────────────────────────────────────────────

function IdentityPanel({
  state,
  canEdit,
  run,
  tenant,
  hostSuffix,
}: PanelProps & { tenant: TenantResponse; hostSuffix: string }) {
  const [name, setName] = useState(tenant.name)
  const [legalName, setLegalName] = useState(tenant.legalName ?? '')
  const [cnpj, setCnpj] = useState(tenant.cnpj ?? '')

  const digits = cnpj.replace(/\D/g, '')
  const cnpjInvalid = digits.length > 0 && digits.length !== 14

  return (
    <Card tone="soft">
      <SectionHead
        icon={<IdCardIcon />}
        tone="icon-system"
        eyebrow="Configurações"
        title="Dados do estabelecimento"
      />
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
        <Field
          label="Endereço na internet"
          htmlFor="slug"
          hint="Definido no cadastro e permanente. É o site do petshop; seus tutores entram na conta deles em /portal."
        >
          <div className="flex items-center gap-2">
            <input id="slug" className="field" value={tenant.slug} readOnly disabled />
            <span className="hint whitespace-nowrap">{hostSuffix}</span>
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

// ─── Endereço e contato públicos (MOD-SITE-02) ───────────────────────────────

const EMPTY_ADDRESS = {
  zipCode: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  state: '',
}

/**
 * O endereço físico do petshop, que até aqui não existia em lugar nenhum do sistema.
 *
 * Cartão próprio, e não mais campos no de cima, porque salva sozinho: os dois PATCHes
 * são endpoints diferentes (`/v1/tenants/me` e `/v1/tenants/me/settings`), e uma falha
 * ao gravar o CNPJ não deve descartar o endereço que o admin acabou de digitar.
 *
 * O endereço é **tudo ou nada**: os seis campos obrigatórios vão juntos, ou o conjunto
 * vai como `null`. É a mesma regra do CHECK no banco, e existe porque um endereço pela
 * metade publicado no site faz quem chega nele concluir que o negócio fechou.
 */
function ContactPanel({
  state,
  canEdit,
  run,
  settings,
}: PanelProps & { settings: TenantSettings }) {
  const [address, setAddress] = useState(
    settings.address
      ? {
          zipCode: formatCEP(settings.address.zipCode),
          street: settings.address.street,
          number: settings.address.number,
          complement: settings.address.complement ?? '',
          district: settings.address.district,
          city: settings.address.city,
          state: settings.address.state,
        }
      : EMPTY_ADDRESS,
  )
  const [phone, setPhone] = useState(
    settings.publicPhone ? formatPhoneBR(settings.publicPhone) : '',
  )
  const [whatsapp, setWhatsapp] = useState(
    settings.publicWhatsapp ? formatPhoneBR(settings.publicWhatsapp) : '',
  )
  const [cepStatus, setCepStatus] = useState<'idle' | 'loading' | 'notfound'>('idle')

  const filled = [
    address.zipCode,
    address.street,
    address.number,
    address.district,
    address.city,
    address.state,
  ].filter((value) => value.trim() !== '')
  const empty = filled.length === 0
  const complete = filled.length === 6
  // Estado intermediário: nem vazio nem completo. O botão espera.
  const incomplete = !empty && !complete

  function handleCepBlur() {
    const digits = address.zipCode.replace(/\D/g, '')
    if (digits.length !== 8) return

    setCepStatus('loading')
    void lookupCepAction(digits).then((found) => {
      if (!found) {
        // CEP inexistente e ViaCEP fora do ar dão no mesmo para quem preenche: segue
        // no braço, como no cadastro de tutor.
        setCepStatus('notfound')
        return
      }
      setCepStatus('idle')
      setAddress((current) => ({
        ...current,
        street: found.street || current.street,
        district: found.district || current.district,
        city: found.city,
        state: found.state,
      }))
    })
  }

  function payload() {
    const nextAddress: TenantAddress | null = complete
      ? {
          zipCode: address.zipCode.replace(/\D/g, ''),
          street: address.street.trim(),
          number: address.number.trim(),
          complement: address.complement.trim() || null,
          district: address.district.trim(),
          city: address.city.trim(),
          state: address.state.trim().toUpperCase(),
        }
      : null

    return {
      address: nextAddress,
      publicPhone: phone.trim() || null,
      publicWhatsapp: whatsapp.trim() || null,
    }
  }

  return (
    <Card tone="soft">
      <SectionHead
        icon={<MapPinIcon />}
        tone="icon-system"
        eyebrow="Configurações"
        title="Onde vocês ficam"
      />
      <p className="hint mt-2">
        É o que aparece para quem procura o petshop: no site, no “como chegar” e no cabeçalho dos
        recibos.
      </p>

      <div className="mt-8 space-y-5">
        <div className="grid gap-5 sm:grid-cols-[10rem_1fr]">
          <Field
            label="CEP"
            htmlFor="addressZip"
            error={state.fieldErrors['address.zipCode']}
            hint={
              cepStatus === 'loading'
                ? 'Buscando…'
                : cepStatus === 'notfound'
                  ? 'Não encontrado — preencha à mão.'
                  : undefined
            }
          >
            <input
              id="addressZip"
              className="field"
              value={address.zipCode}
              onChange={(event) => setAddress({ ...address, zipCode: event.target.value })}
              onBlur={handleCepBlur}
              placeholder="00000-000"
              inputMode="numeric"
              maxLength={9}
              disabled={!canEdit}
            />
          </Field>

          <Field label="Rua" htmlFor="addressStreet" error={state.fieldErrors['address.street']}>
            <input
              id="addressStreet"
              className="field"
              value={address.street}
              onChange={(event) => setAddress({ ...address, street: event.target.value })}
              maxLength={120}
              disabled={!canEdit}
            />
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-[8rem_1fr]">
          <Field label="Número" htmlFor="addressNumber" error={state.fieldErrors['address.number']}>
            <input
              id="addressNumber"
              className="field"
              value={address.number}
              onChange={(event) => setAddress({ ...address, number: event.target.value })}
              maxLength={10}
              disabled={!canEdit}
            />
          </Field>

          <Field label="Complemento" htmlFor="addressComplement" hint="Opcional.">
            <input
              id="addressComplement"
              className="field"
              value={address.complement}
              onChange={(event) => setAddress({ ...address, complement: event.target.value })}
              maxLength={60}
              disabled={!canEdit}
            />
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-[1fr_1fr_6rem]">
          <Field
            label="Bairro"
            htmlFor="addressDistrict"
            error={state.fieldErrors['address.district']}
          >
            <input
              id="addressDistrict"
              className="field"
              value={address.district}
              onChange={(event) => setAddress({ ...address, district: event.target.value })}
              maxLength={80}
              disabled={!canEdit}
            />
          </Field>

          <Field label="Cidade" htmlFor="addressCity" error={state.fieldErrors['address.city']}>
            <input
              id="addressCity"
              className="field"
              value={address.city}
              onChange={(event) => setAddress({ ...address, city: event.target.value })}
              maxLength={80}
              disabled={!canEdit}
            />
          </Field>

          <Field label="UF" htmlFor="addressState" error={state.fieldErrors['address.state']}>
            <input
              id="addressState"
              className="field uppercase"
              value={address.state}
              onChange={(event) => setAddress({ ...address, state: event.target.value })}
              maxLength={2}
              disabled={!canEdit}
            />
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Telefone"
            htmlFor="publicPhone"
            error={state.fieldErrors.publicPhone}
            hint="O número que o cliente liga."
          >
            <input
              id="publicPhone"
              className="field"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="(11) 3000-0000"
              inputMode="tel"
              disabled={!canEdit}
            />
          </Field>

          <Field
            label="WhatsApp"
            htmlFor="publicWhatsapp"
            error={state.fieldErrors.publicWhatsapp}
            hint="Pode ser diferente do número que envia as mensagens automáticas."
          >
            <input
              id="publicWhatsapp"
              className="field"
              value={whatsapp}
              onChange={(event) => setWhatsapp(event.target.value)}
              placeholder="(11) 90000-0000"
              inputMode="tel"
              disabled={!canEdit}
            />
          </Field>
        </div>

        {incomplete && (
          <p className="hint" role="status">
            Preencha CEP, rua, número, bairro, cidade e UF — ou deixe todos em branco. Um endereço
            pela metade não vai para o site.
          </p>
        )}
      </div>

      <SaveButton
        state={state}
        canEdit={canEdit}
        run={run}
        disabled={incomplete}
        onClick={() => run(() => saveContactAction(payload()))}
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
    <Card tone="soft">
      <SectionHead
        icon={<CalendarIcon />}
        tone="icon-system"
        eyebrow="Configurações"
        title="Quando vocês abrem"
      />
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
                    {/*
                      Aqui entra só o átomo `.check`, não o `Choice`: a linha já é
                      uma peça própria, com os horários dentro, e embrulhar a caixa
                      numa segunda linha clicável criaria alvo dentro de alvo.
                    */}
                    <input
                      type="checkbox"
                      className="check"
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
  const [requiresApproval, setRequiresApproval] = useState(settings.onlineBookingRequiresApproval)
  const [overbooking, setOverbooking] = useState(settings.allowOverbooking)

  return (
    <Card tone="soft">
      <SectionHead
        icon={<ShieldCheckIcon />}
        tone="icon-system"
        eyebrow="Configurações"
        title="Como a agenda se comporta"
      />
      <p className="hint mt-2">
        Valem para o portal do tutor e para o agente de IA no WhatsApp. Mudanças só afetam
        agendamentos novos — o que já está marcado mantém a regra do momento em que foi feito.
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

        <div className="-mx-3.5 space-y-2">
          <Choice
            label={<span className="font-medium">Agendamento online</span>}
            description="O tutor marca sozinho pelo portal. Desligado, só a recepção agenda."
            checked={onlineBooking}
            onChange={setOnlineBooking}
            disabled={!canEdit}
          />

          {/*
            Só faz sentido triar o que chega; com o agendamento online desligado não
            chega nada, e a opção viraria uma caixa que não muda coisa alguma.
          */}
          {onlineBooking && (
            <div className="pl-7">
              <Choice
                label={<span className="font-medium">Confirmar cada pedido antes de valer</span>}
                description="O horário fica reservado por 24 horas esperando sua confirmação. Sem isso, o agendamento do portal já entra confirmado."
                checked={requiresApproval}
                onChange={setRequiresApproval}
                disabled={!canEdit}
              />
            </div>
          )}

          <Choice
            label={<span className="font-medium">Permitir encaixe acima da capacidade</span>}
            description="A agenda aceita marcar além dos profissionais disponíveis no horário."
            checked={overbooking}
            onChange={setOverbooking}
            disabled={!canEdit}
          />
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
              onlineBookingRequiresApproval: requiresApproval,
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
    <Card tone="soft">
      <SectionHead
        icon={<PaletteIcon />}
        tone="icon-system"
        eyebrow="Configurações"
        title="A cara do estabelecimento"
      />
      <p className="hint mt-2">A cor aparece no portal do tutor e no site do seu petshop.</p>

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

          {/*
           * Esta é a mesma cor que passa a focar todo campo de formulário do admin
           * (via `--color-focus`, herdado do `AppShell`) — a prévia mostra o efeito
           * antes de salvar, não só o botão e a pílula.
           */}
          <input
            type="text"
            readOnly
            value="Um campo do sistema, em foco"
            aria-label="Prévia do foco em um campo de formulário"
            className="field mt-3 max-w-xs"
            style={
              validColor
                ? {
                    borderColor: primaryColor,
                    boxShadow: `0 1px 0 rgba(255,255,255,0.9) inset, 0 8px 20px -14px rgba(35,36,39,0.25), 0 0 0 3px ${primaryColor}33`,
                  }
                : undefined
            }
          />
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
