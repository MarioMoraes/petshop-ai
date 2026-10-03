import { identityEndpoints } from './endpoints/identity.js'
import { tutorEndpoints } from './endpoints/tutors.js'
import { petEndpoints } from './endpoints/pets.js'
import { recordEndpoints } from './endpoints/records.js'
import { securityEndpoints } from './endpoints/security.js'
import { platformEndpoints } from './endpoints/platform.js'
import { termEndpoints } from './endpoints/terms.js'
import { schedulingEndpoints } from './endpoints/scheduling.js'
import { taxiEndpoints } from './endpoints/taxi.js'
import { ledgerEndpoints } from './endpoints/ledger.js'
import { subscriptionEndpoints } from './endpoints/subscription.js'
import { agentEndpoints } from './endpoints/agent.js'
import { crmEndpoints } from './endpoints/crm.js'
import { siteEndpoints } from './endpoints/site.js'
import { importEndpoints } from './endpoints/import.js'
import { inventoryEndpoints } from './endpoints/inventory.js'
import { cashEndpoints } from './endpoints/cash.js'
import { createTransport, type ApiClientOptions } from './transport.js'

/**
 * Cliente tipado do api-gateway.
 *
 * As respostas são validadas com os mesmos schemas Zod que o backend usa para
 * responder. Um contrato quebrado aparece como erro claro no cliente, em vez de
 * `undefined` propagando até a tela.
 *
 * Um objeto plano, com todos os endpoints, montado a partir de um arquivo por domínio
 * (`endpoints/`). O transporte — teto, token, `problem+json` — é um só, em
 * `transport.ts`. Era um arquivo de três mil linhas até 2026-10-03.
 */
export function createApiClient(options: ApiClientOptions) {
  const transport = createTransport(options)
  return {
    ...identityEndpoints(transport),
    ...tutorEndpoints(transport),
    ...petEndpoints(transport),
    ...recordEndpoints(transport),
    ...securityEndpoints(transport),
    ...platformEndpoints(transport),
    ...termEndpoints(transport),
    ...schedulingEndpoints(transport),
    ...taxiEndpoints(transport),
    ...ledgerEndpoints(transport),
    ...subscriptionEndpoints(transport),
    ...agentEndpoints(transport),
    ...crmEndpoints(transport),
    ...siteEndpoints(transport),
    ...importEndpoints(transport),
    ...inventoryEndpoints(transport),
    ...cashEndpoints(transport),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

export {
  ApiError,
  REQUEST_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  type ApiClientOptions,
  type DownloadedFile,
} from './transport.js'
export type { MessageFilters } from './endpoints/crm.js'

export type {
  ImportBatch,
  ImportEntity,
  ImportEntityInfo,
  ImportReport,
  ImportReportRow,
  ImportRequestInput,
  ImportUndoResult,
  AddressResponse,
  Allergy,
  Breed,
  CepLookup,
  Coat,
  CheckDuplicatesResult,
  ConsentsResponse,
  ManagedBreed,
  MedicalAlert,
  MeResponse,
  OnboardingState,
  PaginatedPets,
  PetAlbum,
  PetPhoto,
  PaginatedTutors,
  PetResponse,
  PetSensitive,
  PetTransfer,
  PetTutorLink,
  PetWeightRecord,
  SafetyRecord,
  Size,
  AppointmentResponse,
  BillingSettings,
  CalendarBlockResponse,
  LedgerAccount,
  LedgerEntry,
  PackagePurchase,
  Cashflow,
  CreditCheckResponse,
  PaginatedPayments,
  Payment,
  ProfessionalResponse,
  Receipt,
  ServicePackage,
  ServiceResponse,
  SlugAvailability,
  PaginatedTaxiRides,
  TaxiBoard,
  TaxiQuote,
  TaxiRideResponse,
  TaxiRoute,
  TaxiSettings,
  TaxiVehicleResponse,
  TaxiZoneResponse,
  Statement,
  Species,
  Tag,
  Temperament,
  TenantResponse,
  TenantSettings,
  TutorDetail,
  TutorOverview,
  TutorSensitive,
} from '@petshop/shared-types'
