// GERADO — não edite à mão.
//
// Origem: packages/shared-types/src/portal.ts (os schemas Zod do backend).
// Gerar de novo: pnpm --filter @petshop/shared-types run gen:dart
//
// Se um campo mudou no backend, ele muda aqui na próxima geração e o `flutter analyze`
// aponta cada lugar do app que precisava saber. É esse o motivo de o arquivo existir.

// As constantes de enum saem em MAIÚSCULAS porque é assim que o backend as escreve no
// JSON — `CRITICAL`, `NO_ADDRESS`, `SERVICE_LIABILITY`. Renomeá-las para o estilo do
// Dart afastaria o modelo do fio sem nada em troca.
// ignore_for_file: constant_identifier_names

import 'dart:convert';

PortalSchema portalSchemaFromJson(String str) => PortalSchema.fromJson(json.decode(str));

String portalSchemaToJson(PortalSchema data) => json.encode(data.toJson());

class PortalSchema {
    final PortalAddress portalAddress;
    final PortalAddressInput portalAddressInput;
    final PortalAppointment portalAppointment;
    final PortalAppointmentActions portalAppointmentActions;
    final PortalAppointmentDetail portalAppointmentDetail;
    final PortalAppointmentsResponse portalAppointmentsResponse;
    final PortalAvailabilityResponse portalAvailabilityResponse;
    final PortalBookableService portalBookableService;
    final PortalBooking portalBooking;
    final PortalBookingServicesResponse portalBookingServicesResponse;
    final PortalBookingTaxi portalBookingTaxi;
    final PortalCancel portalCancel;
    final PortalChallenge portalChallenge;
    final PortalChallengeResponse portalChallengeResponse;
    final PortalChannel portalChannel;
    final PortalChannelPreference portalChannelPreference;
    final PortalContactChange portalContactChange;
    final PortalContactChangeResponse portalContactChangeResponse;
    final PortalContactField portalContactField;
    final PortalContactVerify portalContactVerify;
    final PortalContextResponse portalContextResponse;
    final PortalDeletionRequest portalDeletionRequest;
    final PortalDeletionRequestInput portalDeletionRequestInput;
    final PortalDevice portalDevice;
    final PortalDeviceForget portalDeviceForget;
    final PortalDevicePlatform portalDevicePlatform;
    final PortalDirectoryEntry portalDirectoryEntry;
    final PortalDirectoryResponse portalDirectoryResponse;
    final PortalDocument portalDocument;
    final PortalDocumentsResponse portalDocumentsResponse;
    final PortalFinanceResponse portalFinanceResponse;
    final PortalMeDataResponse portalMeDataResponse;
    final PortalMessage portalMessage;
    final PortalMessagesResponse portalMessagesResponse;
    final PortalNextAppointment portalNextAppointment;
    final PortalPackage portalPackage;
    final PortalPaymentInstructions portalPaymentInstructions;
    final PortalPetAlert portalPetAlert;
    final PortalPetDetail portalPetDetail;
    final PortalPetSummary portalPetSummary;
    final PortalPreferencesResponse portalPreferencesResponse;
    final PortalProfile portalProfile;
    final PortalReceiptResponse portalReceiptResponse;
    final PortalReschedule portalReschedule;
    final PortalSlot portalSlot;
    final PortalStatementEntry portalStatementEntry;
    final PortalStatementResponse portalStatementResponse;
    final PortalTaxiOffer portalTaxiOffer;
    final PortalTaxiRide portalTaxiRide;
    final PortalTaxiUnavailableReason portalTaxiUnavailableReason;
    final PortalTenantResponse portalTenantResponse;
    final PortalTerm portalTerm;
    final PortalTermsResponse portalTermsResponse;
    final PortalTimelineEntry portalTimelineEntry;
    final PortalTimelineResponse portalTimelineResponse;
    final PortalUpcomingAppointment portalUpcomingAppointment;
    final PortalVerify portalVerify;
    final UpdateOwnPet updateOwnPet;
    final UpdateOwnTutor updateOwnTutor;
    final UpdatePortalAddress updatePortalAddress;
    final UpdatePortalPreference updatePortalPreference;

    PortalSchema({
        required this.portalAddress,
        required this.portalAddressInput,
        required this.portalAppointment,
        required this.portalAppointmentActions,
        required this.portalAppointmentDetail,
        required this.portalAppointmentsResponse,
        required this.portalAvailabilityResponse,
        required this.portalBookableService,
        required this.portalBooking,
        required this.portalBookingServicesResponse,
        required this.portalBookingTaxi,
        required this.portalCancel,
        required this.portalChallenge,
        required this.portalChallengeResponse,
        required this.portalChannel,
        required this.portalChannelPreference,
        required this.portalContactChange,
        required this.portalContactChangeResponse,
        required this.portalContactField,
        required this.portalContactVerify,
        required this.portalContextResponse,
        required this.portalDeletionRequest,
        required this.portalDeletionRequestInput,
        required this.portalDevice,
        required this.portalDeviceForget,
        required this.portalDevicePlatform,
        required this.portalDirectoryEntry,
        required this.portalDirectoryResponse,
        required this.portalDocument,
        required this.portalDocumentsResponse,
        required this.portalFinanceResponse,
        required this.portalMeDataResponse,
        required this.portalMessage,
        required this.portalMessagesResponse,
        required this.portalNextAppointment,
        required this.portalPackage,
        required this.portalPaymentInstructions,
        required this.portalPetAlert,
        required this.portalPetDetail,
        required this.portalPetSummary,
        required this.portalPreferencesResponse,
        required this.portalProfile,
        required this.portalReceiptResponse,
        required this.portalReschedule,
        required this.portalSlot,
        required this.portalStatementEntry,
        required this.portalStatementResponse,
        required this.portalTaxiOffer,
        required this.portalTaxiRide,
        required this.portalTaxiUnavailableReason,
        required this.portalTenantResponse,
        required this.portalTerm,
        required this.portalTermsResponse,
        required this.portalTimelineEntry,
        required this.portalTimelineResponse,
        required this.portalUpcomingAppointment,
        required this.portalVerify,
        required this.updateOwnPet,
        required this.updateOwnTutor,
        required this.updatePortalAddress,
        required this.updatePortalPreference,
    });

    factory PortalSchema.fromJson(Map<String, dynamic> json) => PortalSchema(
        portalAddress: PortalAddress.fromJson(json["PortalAddress"]),
        portalAddressInput: PortalAddressInput.fromJson(json["PortalAddressInput"]),
        portalAppointment: PortalAppointment.fromJson(json["PortalAppointment"]),
        portalAppointmentActions: PortalAppointmentActions.fromJson(json["PortalAppointmentActions"]),
        portalAppointmentDetail: PortalAppointmentDetail.fromJson(json["PortalAppointmentDetail"]),
        portalAppointmentsResponse: PortalAppointmentsResponse.fromJson(json["PortalAppointmentsResponse"]),
        portalAvailabilityResponse: PortalAvailabilityResponse.fromJson(json["PortalAvailabilityResponse"]),
        portalBookableService: PortalBookableService.fromJson(json["PortalBookableService"]),
        portalBooking: PortalBooking.fromJson(json["PortalBooking"]),
        portalBookingServicesResponse: PortalBookingServicesResponse.fromJson(json["PortalBookingServicesResponse"]),
        portalBookingTaxi: PortalBookingTaxi.fromJson(json["PortalBookingTaxi"]),
        portalCancel: PortalCancel.fromJson(json["PortalCancel"]),
        portalChallenge: PortalChallenge.fromJson(json["PortalChallenge"]),
        portalChallengeResponse: PortalChallengeResponse.fromJson(json["PortalChallengeResponse"]),
        portalChannel: portalChannelValues.map[json["PortalChannel"]]!,
        portalChannelPreference: PortalChannelPreference.fromJson(json["PortalChannelPreference"]),
        portalContactChange: PortalContactChange.fromJson(json["PortalContactChange"]),
        portalContactChangeResponse: PortalContactChangeResponse.fromJson(json["PortalContactChangeResponse"]),
        portalContactField: portalContactFieldValues.map[json["PortalContactField"]]!,
        portalContactVerify: PortalContactVerify.fromJson(json["PortalContactVerify"]),
        portalContextResponse: PortalContextResponse.fromJson(json["PortalContextResponse"]),
        portalDeletionRequest: PortalDeletionRequest.fromJson(json["PortalDeletionRequest"]),
        portalDeletionRequestInput: PortalDeletionRequestInput.fromJson(json["PortalDeletionRequestInput"]),
        portalDevice: PortalDevice.fromJson(json["PortalDevice"]),
        portalDeviceForget: PortalDeviceForget.fromJson(json["PortalDeviceForget"]),
        portalDevicePlatform: portalDevicePlatformValues.map[json["PortalDevicePlatform"]]!,
        portalDirectoryEntry: PortalDirectoryEntry.fromJson(json["PortalDirectoryEntry"]),
        portalDirectoryResponse: PortalDirectoryResponse.fromJson(json["PortalDirectoryResponse"]),
        portalDocument: PortalDocument.fromJson(json["PortalDocument"]),
        portalDocumentsResponse: PortalDocumentsResponse.fromJson(json["PortalDocumentsResponse"]),
        portalFinanceResponse: PortalFinanceResponse.fromJson(json["PortalFinanceResponse"]),
        portalMeDataResponse: PortalMeDataResponse.fromJson(json["PortalMeDataResponse"]),
        portalMessage: PortalMessage.fromJson(json["PortalMessage"]),
        portalMessagesResponse: PortalMessagesResponse.fromJson(json["PortalMessagesResponse"]),
        portalNextAppointment: PortalNextAppointment.fromJson(json["PortalNextAppointment"]),
        portalPackage: PortalPackage.fromJson(json["PortalPackage"]),
        portalPaymentInstructions: PortalPaymentInstructions.fromJson(json["PortalPaymentInstructions"]),
        portalPetAlert: PortalPetAlert.fromJson(json["PortalPetAlert"]),
        portalPetDetail: PortalPetDetail.fromJson(json["PortalPetDetail"]),
        portalPetSummary: PortalPetSummary.fromJson(json["PortalPetSummary"]),
        portalPreferencesResponse: PortalPreferencesResponse.fromJson(json["PortalPreferencesResponse"]),
        portalProfile: PortalProfile.fromJson(json["PortalProfile"]),
        portalReceiptResponse: PortalReceiptResponse.fromJson(json["PortalReceiptResponse"]),
        portalReschedule: PortalReschedule.fromJson(json["PortalReschedule"]),
        portalSlot: PortalSlot.fromJson(json["PortalSlot"]),
        portalStatementEntry: PortalStatementEntry.fromJson(json["PortalStatementEntry"]),
        portalStatementResponse: PortalStatementResponse.fromJson(json["PortalStatementResponse"]),
        portalTaxiOffer: PortalTaxiOffer.fromJson(json["PortalTaxiOffer"]),
        portalTaxiRide: PortalTaxiRide.fromJson(json["PortalTaxiRide"]),
        portalTaxiUnavailableReason: portalTaxiUnavailableReasonValues.map[json["PortalTaxiUnavailableReason"]]!,
        portalTenantResponse: PortalTenantResponse.fromJson(json["PortalTenantResponse"]),
        portalTerm: PortalTerm.fromJson(json["PortalTerm"]),
        portalTermsResponse: PortalTermsResponse.fromJson(json["PortalTermsResponse"]),
        portalTimelineEntry: PortalTimelineEntry.fromJson(json["PortalTimelineEntry"]),
        portalTimelineResponse: PortalTimelineResponse.fromJson(json["PortalTimelineResponse"]),
        portalUpcomingAppointment: PortalUpcomingAppointment.fromJson(json["PortalUpcomingAppointment"]),
        portalVerify: PortalVerify.fromJson(json["PortalVerify"]),
        updateOwnPet: UpdateOwnPet.fromJson(json["UpdateOwnPet"]),
        updateOwnTutor: UpdateOwnTutor.fromJson(json["UpdateOwnTutor"]),
        updatePortalAddress: UpdatePortalAddress.fromJson(json["UpdatePortalAddress"]),
        updatePortalPreference: UpdatePortalPreference.fromJson(json["UpdatePortalPreference"]),
    );

    Map<String, dynamic> toJson() => {
        "PortalAddress": portalAddress.toJson(),
        "PortalAddressInput": portalAddressInput.toJson(),
        "PortalAppointment": portalAppointment.toJson(),
        "PortalAppointmentActions": portalAppointmentActions.toJson(),
        "PortalAppointmentDetail": portalAppointmentDetail.toJson(),
        "PortalAppointmentsResponse": portalAppointmentsResponse.toJson(),
        "PortalAvailabilityResponse": portalAvailabilityResponse.toJson(),
        "PortalBookableService": portalBookableService.toJson(),
        "PortalBooking": portalBooking.toJson(),
        "PortalBookingServicesResponse": portalBookingServicesResponse.toJson(),
        "PortalBookingTaxi": portalBookingTaxi.toJson(),
        "PortalCancel": portalCancel.toJson(),
        "PortalChallenge": portalChallenge.toJson(),
        "PortalChallengeResponse": portalChallengeResponse.toJson(),
        "PortalChannel": portalChannelValues.reverse[portalChannel],
        "PortalChannelPreference": portalChannelPreference.toJson(),
        "PortalContactChange": portalContactChange.toJson(),
        "PortalContactChangeResponse": portalContactChangeResponse.toJson(),
        "PortalContactField": portalContactFieldValues.reverse[portalContactField],
        "PortalContactVerify": portalContactVerify.toJson(),
        "PortalContextResponse": portalContextResponse.toJson(),
        "PortalDeletionRequest": portalDeletionRequest.toJson(),
        "PortalDeletionRequestInput": portalDeletionRequestInput.toJson(),
        "PortalDevice": portalDevice.toJson(),
        "PortalDeviceForget": portalDeviceForget.toJson(),
        "PortalDevicePlatform": portalDevicePlatformValues.reverse[portalDevicePlatform],
        "PortalDirectoryEntry": portalDirectoryEntry.toJson(),
        "PortalDirectoryResponse": portalDirectoryResponse.toJson(),
        "PortalDocument": portalDocument.toJson(),
        "PortalDocumentsResponse": portalDocumentsResponse.toJson(),
        "PortalFinanceResponse": portalFinanceResponse.toJson(),
        "PortalMeDataResponse": portalMeDataResponse.toJson(),
        "PortalMessage": portalMessage.toJson(),
        "PortalMessagesResponse": portalMessagesResponse.toJson(),
        "PortalNextAppointment": portalNextAppointment.toJson(),
        "PortalPackage": portalPackage.toJson(),
        "PortalPaymentInstructions": portalPaymentInstructions.toJson(),
        "PortalPetAlert": portalPetAlert.toJson(),
        "PortalPetDetail": portalPetDetail.toJson(),
        "PortalPetSummary": portalPetSummary.toJson(),
        "PortalPreferencesResponse": portalPreferencesResponse.toJson(),
        "PortalProfile": portalProfile.toJson(),
        "PortalReceiptResponse": portalReceiptResponse.toJson(),
        "PortalReschedule": portalReschedule.toJson(),
        "PortalSlot": portalSlot.toJson(),
        "PortalStatementEntry": portalStatementEntry.toJson(),
        "PortalStatementResponse": portalStatementResponse.toJson(),
        "PortalTaxiOffer": portalTaxiOffer.toJson(),
        "PortalTaxiRide": portalTaxiRide.toJson(),
        "PortalTaxiUnavailableReason": portalTaxiUnavailableReasonValues.reverse[portalTaxiUnavailableReason],
        "PortalTenantResponse": portalTenantResponse.toJson(),
        "PortalTerm": portalTerm.toJson(),
        "PortalTermsResponse": portalTermsResponse.toJson(),
        "PortalTimelineEntry": portalTimelineEntry.toJson(),
        "PortalTimelineResponse": portalTimelineResponse.toJson(),
        "PortalUpcomingAppointment": portalUpcomingAppointment.toJson(),
        "PortalVerify": portalVerify.toJson(),
        "UpdateOwnPet": updateOwnPet.toJson(),
        "UpdateOwnTutor": updateOwnTutor.toJson(),
        "UpdatePortalAddress": updatePortalAddress.toJson(),
        "UpdatePortalPreference": updatePortalPreference.toJson(),
    };
}

class PortalAddress {
    final String? accessNotes;
    final String city;
    final String? complement;
    final String district;
    final String id;
    final bool isPrimary;
    final String label;
    final String number;
    final String state;
    final String street;
    final String zipCode;

    PortalAddress({
        required this.accessNotes,
        required this.city,
        required this.complement,
        required this.district,
        required this.id,
        required this.isPrimary,
        required this.label,
        required this.number,
        required this.state,
        required this.street,
        required this.zipCode,
    });

    factory PortalAddress.fromJson(Map<String, dynamic> json) => PortalAddress(
        accessNotes: json["accessNotes"],
        city: json["city"],
        complement: json["complement"],
        district: json["district"],
        id: json["id"],
        isPrimary: json["isPrimary"],
        label: json["label"],
        number: json["number"],
        state: json["state"],
        street: json["street"],
        zipCode: json["zipCode"],
    );

    Map<String, dynamic> toJson() => {
        "accessNotes": accessNotes,
        "city": city,
        "complement": complement,
        "district": district,
        "id": id,
        "isPrimary": isPrimary,
        "label": label,
        "number": number,
        "state": state,
        "street": street,
        "zipCode": zipCode,
    };
}

class PortalAddressInput {
    final String? accessNotes;
    final String city;
    final String? complement;
    final String district;
    final bool? isPrimary;
    final String? label;
    final String number;
    final String state;
    final String street;
    final String zipCode;

    PortalAddressInput({
        this.accessNotes,
        required this.city,
        this.complement,
        required this.district,
        this.isPrimary,
        this.label,
        required this.number,
        required this.state,
        required this.street,
        required this.zipCode,
    });

    factory PortalAddressInput.fromJson(Map<String, dynamic> json) => PortalAddressInput(
        accessNotes: json["accessNotes"],
        city: json["city"],
        complement: json["complement"],
        district: json["district"],
        isPrimary: json["isPrimary"],
        label: json["label"],
        number: json["number"],
        state: json["state"],
        street: json["street"],
        zipCode: json["zipCode"],
    );

    Map<String, dynamic> toJson() => {
        "accessNotes": accessNotes,
        "city": city,
        "complement": complement,
        "district": district,
        "isPrimary": isPrimary,
        "label": label,
        "number": number,
        "state": state,
        "street": street,
        "zipCode": zipCode,
    };
}

class PortalAppointment {
    final bool awaitingApproval;
    final String endsAt;
    final String id;
    final String petId;
    final String petName;
    final String professionalName;
    final List<String> services;
    final String startsAt;
    final String status;
    final List<PortalTaxiRide> taxi;
    final int totalCents;

    PortalAppointment({
        required this.awaitingApproval,
        required this.endsAt,
        required this.id,
        required this.petId,
        required this.petName,
        required this.professionalName,
        required this.services,
        required this.startsAt,
        required this.status,
        required this.taxi,
        required this.totalCents,
    });

    factory PortalAppointment.fromJson(Map<String, dynamic> json) => PortalAppointment(
        awaitingApproval: json["awaitingApproval"],
        endsAt: json["endsAt"],
        id: json["id"],
        petId: json["petId"],
        petName: json["petName"],
        professionalName: json["professionalName"],
        services: List<String>.from(json["services"].map((x) => x)),
        startsAt: json["startsAt"],
        status: json["status"],
        taxi: List<PortalTaxiRide>.from(json["taxi"].map((x) => PortalTaxiRide.fromJson(x))),
        totalCents: json["totalCents"],
    );

    Map<String, dynamic> toJson() => {
        "awaitingApproval": awaitingApproval,
        "endsAt": endsAt,
        "id": id,
        "petId": petId,
        "petName": petName,
        "professionalName": professionalName,
        "services": List<dynamic>.from(services.map((x) => x)),
        "startsAt": startsAt,
        "status": status,
        "taxi": List<dynamic>.from(taxi.map((x) => x.toJson())),
        "totalCents": totalCents,
    };
}

class PortalTaxiRide {
    final String id;
    final Leg leg;
    final String legLabel;
    final int priceCents;
    final PortalTaxiRideStatus status;
    final String statusText;
    final String windowEndsAt;
    final String windowStartsAt;

    PortalTaxiRide({
        required this.id,
        required this.leg,
        required this.legLabel,
        required this.priceCents,
        required this.status,
        required this.statusText,
        required this.windowEndsAt,
        required this.windowStartsAt,
    });

    factory PortalTaxiRide.fromJson(Map<String, dynamic> json) => PortalTaxiRide(
        id: json["id"],
        leg: legValues.map[json["leg"]]!,
        legLabel: json["legLabel"],
        priceCents: json["priceCents"],
        status: portalTaxiRideStatusValues.map[json["status"]]!,
        statusText: json["statusText"],
        windowEndsAt: json["windowEndsAt"],
        windowStartsAt: json["windowStartsAt"],
    );

    Map<String, dynamic> toJson() => {
        "id": id,
        "leg": legValues.reverse[leg],
        "legLabel": legLabel,
        "priceCents": priceCents,
        "status": portalTaxiRideStatusValues.reverse[status],
        "statusText": statusText,
        "windowEndsAt": windowEndsAt,
        "windowStartsAt": windowStartsAt,
    };
}

enum Leg {
    DROPOFF,
    PICKUP
}

final legValues = EnumValues({
    "DROPOFF": Leg.DROPOFF,
    "PICKUP": Leg.PICKUP
});

enum PortalTaxiRideStatus {
    ARRIVED,
    ASSIGNED,
    CANCELLED,
    DELIVERED,
    EN_ROUTE,
    FAILED,
    ONBOARD,
    REQUESTED
}

final portalTaxiRideStatusValues = EnumValues({
    "ARRIVED": PortalTaxiRideStatus.ARRIVED,
    "ASSIGNED": PortalTaxiRideStatus.ASSIGNED,
    "CANCELLED": PortalTaxiRideStatus.CANCELLED,
    "DELIVERED": PortalTaxiRideStatus.DELIVERED,
    "EN_ROUTE": PortalTaxiRideStatus.EN_ROUTE,
    "FAILED": PortalTaxiRideStatus.FAILED,
    "ONBOARD": PortalTaxiRideStatus.ONBOARD,
    "REQUESTED": PortalTaxiRideStatus.REQUESTED
});

class PortalAppointmentActions {
    final bool canCancel;
    final int cancelFeeCents;
    final bool cancelIsLate;
    final int cancellationWindowHours;
    final bool canReschedule;

    PortalAppointmentActions({
        required this.canCancel,
        required this.cancelFeeCents,
        required this.cancelIsLate,
        required this.cancellationWindowHours,
        required this.canReschedule,
    });

    factory PortalAppointmentActions.fromJson(Map<String, dynamic> json) => PortalAppointmentActions(
        canCancel: json["canCancel"],
        cancelFeeCents: json["cancelFeeCents"],
        cancelIsLate: json["cancelIsLate"],
        cancellationWindowHours: json["cancellationWindowHours"],
        canReschedule: json["canReschedule"],
    );

    Map<String, dynamic> toJson() => {
        "canCancel": canCancel,
        "cancelFeeCents": cancelFeeCents,
        "cancelIsLate": cancelIsLate,
        "cancellationWindowHours": cancellationWindowHours,
        "canReschedule": canReschedule,
    };
}

class PortalAppointmentDetail {
    final PortalAppointmentActions actions;
    final bool awaitingApproval;
    final String? cancelledAt;
    final bool? cancelledLate;
    final String endsAt;
    final String id;
    final String petId;
    final String petName;
    final String professionalName;
    final List<String> serviceIds;
    final List<String> services;
    final String source;
    final String startsAt;
    final String status;
    final List<PortalTaxiRide> taxi;
    final int totalCents;

    PortalAppointmentDetail({
        required this.actions,
        required this.awaitingApproval,
        required this.cancelledAt,
        required this.cancelledLate,
        required this.endsAt,
        required this.id,
        required this.petId,
        required this.petName,
        required this.professionalName,
        required this.serviceIds,
        required this.services,
        required this.source,
        required this.startsAt,
        required this.status,
        required this.taxi,
        required this.totalCents,
    });

    factory PortalAppointmentDetail.fromJson(Map<String, dynamic> json) => PortalAppointmentDetail(
        actions: PortalAppointmentActions.fromJson(json["actions"]),
        awaitingApproval: json["awaitingApproval"],
        cancelledAt: json["cancelledAt"],
        cancelledLate: json["cancelledLate"],
        endsAt: json["endsAt"],
        id: json["id"],
        petId: json["petId"],
        petName: json["petName"],
        professionalName: json["professionalName"],
        serviceIds: List<String>.from(json["serviceIds"].map((x) => x)),
        services: List<String>.from(json["services"].map((x) => x)),
        source: json["source"],
        startsAt: json["startsAt"],
        status: json["status"],
        taxi: List<PortalTaxiRide>.from(json["taxi"].map((x) => PortalTaxiRide.fromJson(x))),
        totalCents: json["totalCents"],
    );

    Map<String, dynamic> toJson() => {
        "actions": actions.toJson(),
        "awaitingApproval": awaitingApproval,
        "cancelledAt": cancelledAt,
        "cancelledLate": cancelledLate,
        "endsAt": endsAt,
        "id": id,
        "petId": petId,
        "petName": petName,
        "professionalName": professionalName,
        "serviceIds": List<dynamic>.from(serviceIds.map((x) => x)),
        "services": List<dynamic>.from(services.map((x) => x)),
        "source": source,
        "startsAt": startsAt,
        "status": status,
        "taxi": List<dynamic>.from(taxi.map((x) => x.toJson())),
        "totalCents": totalCents,
    };
}

class PortalAppointmentsResponse {
    final String? nextCursor;
    final List<PortalAppointment> past;
    final String timezone;
    final List<PortalUpcomingAppointment> upcoming;

    PortalAppointmentsResponse({
        required this.nextCursor,
        required this.past,
        required this.timezone,
        required this.upcoming,
    });

    factory PortalAppointmentsResponse.fromJson(Map<String, dynamic> json) => PortalAppointmentsResponse(
        nextCursor: json["nextCursor"],
        past: List<PortalAppointment>.from(json["past"].map((x) => PortalAppointment.fromJson(x))),
        timezone: json["timezone"],
        upcoming: List<PortalUpcomingAppointment>.from(json["upcoming"].map((x) => PortalUpcomingAppointment.fromJson(x))),
    );

    Map<String, dynamic> toJson() => {
        "nextCursor": nextCursor,
        "past": List<dynamic>.from(past.map((x) => x.toJson())),
        "timezone": timezone,
        "upcoming": List<dynamic>.from(upcoming.map((x) => x.toJson())),
    };
}

class PortalUpcomingAppointment {
    final PortalAppointmentActions actions;
    final bool awaitingApproval;
    final String endsAt;
    final String id;
    final String petId;
    final String petName;
    final String professionalName;
    final List<String> services;
    final String startsAt;
    final String status;
    final List<PortalTaxiRide> taxi;
    final int totalCents;

    PortalUpcomingAppointment({
        required this.actions,
        required this.awaitingApproval,
        required this.endsAt,
        required this.id,
        required this.petId,
        required this.petName,
        required this.professionalName,
        required this.services,
        required this.startsAt,
        required this.status,
        required this.taxi,
        required this.totalCents,
    });

    factory PortalUpcomingAppointment.fromJson(Map<String, dynamic> json) => PortalUpcomingAppointment(
        actions: PortalAppointmentActions.fromJson(json["actions"]),
        awaitingApproval: json["awaitingApproval"],
        endsAt: json["endsAt"],
        id: json["id"],
        petId: json["petId"],
        petName: json["petName"],
        professionalName: json["professionalName"],
        services: List<String>.from(json["services"].map((x) => x)),
        startsAt: json["startsAt"],
        status: json["status"],
        taxi: List<PortalTaxiRide>.from(json["taxi"].map((x) => PortalTaxiRide.fromJson(x))),
        totalCents: json["totalCents"],
    );

    Map<String, dynamic> toJson() => {
        "actions": actions.toJson(),
        "awaitingApproval": awaitingApproval,
        "endsAt": endsAt,
        "id": id,
        "petId": petId,
        "petName": petName,
        "professionalName": professionalName,
        "services": List<dynamic>.from(services.map((x) => x)),
        "startsAt": startsAt,
        "status": status,
        "taxi": List<dynamic>.from(taxi.map((x) => x.toJson())),
        "totalCents": totalCents,
    };
}

class PortalAvailabilityResponse {
    final int durationMin;
    final int minNoticeHours;
    final String? nextAvailable;
    final int priceCents;
    final List<PortalSlot> slots;
    final String timezone;

    PortalAvailabilityResponse({
        required this.durationMin,
        required this.minNoticeHours,
        required this.nextAvailable,
        required this.priceCents,
        required this.slots,
        required this.timezone,
    });

    factory PortalAvailabilityResponse.fromJson(Map<String, dynamic> json) => PortalAvailabilityResponse(
        durationMin: json["durationMin"],
        minNoticeHours: json["minNoticeHours"],
        nextAvailable: json["nextAvailable"],
        priceCents: json["priceCents"],
        slots: List<PortalSlot>.from(json["slots"].map((x) => PortalSlot.fromJson(x))),
        timezone: json["timezone"],
    );

    Map<String, dynamic> toJson() => {
        "durationMin": durationMin,
        "minNoticeHours": minNoticeHours,
        "nextAvailable": nextAvailable,
        "priceCents": priceCents,
        "slots": List<dynamic>.from(slots.map((x) => x.toJson())),
        "timezone": timezone,
    };
}

class PortalSlot {
    final String endsAt;
    final String professionalId;
    final String professionalName;
    final String startsAt;

    PortalSlot({
        required this.endsAt,
        required this.professionalId,
        required this.professionalName,
        required this.startsAt,
    });

    factory PortalSlot.fromJson(Map<String, dynamic> json) => PortalSlot(
        endsAt: json["endsAt"],
        professionalId: json["professionalId"],
        professionalName: json["professionalName"],
        startsAt: json["startsAt"],
    );

    Map<String, dynamic> toJson() => {
        "endsAt": endsAt,
        "professionalId": professionalId,
        "professionalName": professionalName,
        "startsAt": startsAt,
    };
}

class PortalBookableService {
    final String category;
    final String? description;
    final int durationMin;
    final String id;
    final String name;
    final int priceCents;

    PortalBookableService({
        required this.category,
        required this.description,
        required this.durationMin,
        required this.id,
        required this.name,
        required this.priceCents,
    });

    factory PortalBookableService.fromJson(Map<String, dynamic> json) => PortalBookableService(
        category: json["category"],
        description: json["description"],
        durationMin: json["durationMin"],
        id: json["id"],
        name: json["name"],
        priceCents: json["priceCents"],
    );

    Map<String, dynamic> toJson() => {
        "category": category,
        "description": description,
        "durationMin": durationMin,
        "id": id,
        "name": name,
        "priceCents": priceCents,
    };
}

class PortalBooking {
    final bool acknowledgedAlerts;
    final String? notes;
    final String petId;
    final String professionalId;
    final List<String> serviceIds;
    final DateTime startsAt;
    final PortalBookingTaxi? taxi;

    PortalBooking({
        required this.acknowledgedAlerts,
        this.notes,
        required this.petId,
        required this.professionalId,
        required this.serviceIds,
        required this.startsAt,
        this.taxi,
    });

    factory PortalBooking.fromJson(Map<String, dynamic> json) => PortalBooking(
        acknowledgedAlerts: json["acknowledgedAlerts"],
        notes: json["notes"],
        petId: json["petId"],
        professionalId: json["professionalId"],
        serviceIds: List<String>.from(json["serviceIds"].map((x) => x)),
        startsAt: DateTime.parse(json["startsAt"]),
        taxi: json["taxi"] == null ? null : PortalBookingTaxi.fromJson(json["taxi"]),
    );

    Map<String, dynamic> toJson() => {
        "acknowledgedAlerts": acknowledgedAlerts,
        "notes": notes,
        "petId": petId,
        "professionalId": professionalId,
        "serviceIds": List<dynamic>.from(serviceIds.map((x) => x)),
        "startsAt": startsAt.toIso8601String(),
        "taxi": taxi?.toJson(),
    };
}

class PortalBookingTaxi {
    final bool dropoff;
    final bool pickup;

    PortalBookingTaxi({
        required this.dropoff,
        required this.pickup,
    });

    factory PortalBookingTaxi.fromJson(Map<String, dynamic> json) => PortalBookingTaxi(
        dropoff: json["dropoff"],
        pickup: json["pickup"],
    );

    Map<String, dynamic> toJson() => {
        "dropoff": dropoff,
        "pickup": pickup,
    };
}

class PortalBookingServicesResponse {
    final String petName;
    final List<PortalBookableService> services;

    PortalBookingServicesResponse({
        required this.petName,
        required this.services,
    });

    factory PortalBookingServicesResponse.fromJson(Map<String, dynamic> json) => PortalBookingServicesResponse(
        petName: json["petName"],
        services: List<PortalBookableService>.from(json["services"].map((x) => PortalBookableService.fromJson(x))),
    );

    Map<String, dynamic> toJson() => {
        "petName": petName,
        "services": List<dynamic>.from(services.map((x) => x.toJson())),
    };
}

class PortalCancel {
    final bool acknowledgeFee;

    PortalCancel({
        required this.acknowledgeFee,
    });

    factory PortalCancel.fromJson(Map<String, dynamic> json) => PortalCancel(
        acknowledgeFee: json["acknowledgeFee"],
    );

    Map<String, dynamic> toJson() => {
        "acknowledgeFee": acknowledgeFee,
    };
}

class PortalChallenge {
    final String identifier;
    final String? website;

    PortalChallenge({
        required this.identifier,
        this.website,
    });

    factory PortalChallenge.fromJson(Map<String, dynamic> json) => PortalChallenge(
        identifier: json["identifier"],
        website: json["website"],
    );

    Map<String, dynamic> toJson() => {
        "identifier": identifier,
        "website": website,
    };
}

class PortalChallengeResponse {
    final String challengeId;
    final PortalChannel channel;
    final int expiresInMin;
    final String maskedTarget;

    PortalChallengeResponse({
        required this.challengeId,
        required this.channel,
        required this.expiresInMin,
        required this.maskedTarget,
    });

    factory PortalChallengeResponse.fromJson(Map<String, dynamic> json) => PortalChallengeResponse(
        challengeId: json["challengeId"],
        channel: portalChannelValues.map[json["channel"]]!,
        expiresInMin: json["expiresInMin"],
        maskedTarget: json["maskedTarget"],
    );

    Map<String, dynamic> toJson() => {
        "challengeId": challengeId,
        "channel": portalChannelValues.reverse[channel],
        "expiresInMin": expiresInMin,
        "maskedTarget": maskedTarget,
    };
}

enum PortalChannel {
    EMAIL,
    WHATSAPP
}

final portalChannelValues = EnumValues({
    "EMAIL": PortalChannel.EMAIL,
    "WHATSAPP": PortalChannel.WHATSAPP
});

class PortalChannelPreference {
    final PortalChannel channel;
    final bool granted;
    final String? since;

    PortalChannelPreference({
        required this.channel,
        required this.granted,
        required this.since,
    });

    factory PortalChannelPreference.fromJson(Map<String, dynamic> json) => PortalChannelPreference(
        channel: portalChannelValues.map[json["channel"]]!,
        granted: json["granted"],
        since: json["since"],
    );

    Map<String, dynamic> toJson() => {
        "channel": portalChannelValues.reverse[channel],
        "granted": granted,
        "since": since,
    };
}

class PortalContactChange {
    final PortalContactField field;
    final String value;

    PortalContactChange({
        required this.field,
        required this.value,
    });

    factory PortalContactChange.fromJson(Map<String, dynamic> json) => PortalContactChange(
        field: portalContactFieldValues.map[json["field"]]!,
        value: json["value"],
    );

    Map<String, dynamic> toJson() => {
        "field": portalContactFieldValues.reverse[field],
        "value": value,
    };
}

enum PortalContactField {
    EMAIL,
    PHONE
}

final portalContactFieldValues = EnumValues({
    "EMAIL": PortalContactField.EMAIL,
    "PHONE": PortalContactField.PHONE
});

class PortalContactChangeResponse {
    final String changeId;
    final PortalChannel channel;
    final int expiresInMin;
    final PortalContactField field;
    final String maskedTarget;

    PortalContactChangeResponse({
        required this.changeId,
        required this.channel,
        required this.expiresInMin,
        required this.field,
        required this.maskedTarget,
    });

    factory PortalContactChangeResponse.fromJson(Map<String, dynamic> json) => PortalContactChangeResponse(
        changeId: json["changeId"],
        channel: portalChannelValues.map[json["channel"]]!,
        expiresInMin: json["expiresInMin"],
        field: portalContactFieldValues.map[json["field"]]!,
        maskedTarget: json["maskedTarget"],
    );

    Map<String, dynamic> toJson() => {
        "changeId": changeId,
        "channel": portalChannelValues.reverse[channel],
        "expiresInMin": expiresInMin,
        "field": portalContactFieldValues.reverse[field],
        "maskedTarget": maskedTarget,
    };
}

class PortalContactVerify {
    final String changeId;
    final String code;

    PortalContactVerify({
        required this.changeId,
        required this.code,
    });

    factory PortalContactVerify.fromJson(Map<String, dynamic> json) => PortalContactVerify(
        changeId: json["changeId"],
        code: json["code"],
    );

    Map<String, dynamic> toJson() => {
        "changeId": changeId,
        "code": code,
    };
}

class PortalContextResponse {
    final Features features;
    final Tenant tenant;
    final Tutor tutor;

    PortalContextResponse({
        required this.features,
        required this.tenant,
        required this.tutor,
    });

    factory PortalContextResponse.fromJson(Map<String, dynamic> json) => PortalContextResponse(
        features: Features.fromJson(json["features"]),
        tenant: Tenant.fromJson(json["tenant"]),
        tutor: Tutor.fromJson(json["tutor"]),
    );

    Map<String, dynamic> toJson() => {
        "features": features.toJson(),
        "tenant": tenant.toJson(),
        "tutor": tutor.toJson(),
    };
}

class Features {
    final bool onlineBookingEnabled;
    final bool onlineBookingRequiresApproval;
    final bool portalEnabled;
    final bool taxiEnabled;

    Features({
        required this.onlineBookingEnabled,
        required this.onlineBookingRequiresApproval,
        required this.portalEnabled,
        required this.taxiEnabled,
    });

    factory Features.fromJson(Map<String, dynamic> json) => Features(
        onlineBookingEnabled: json["onlineBookingEnabled"],
        onlineBookingRequiresApproval: json["onlineBookingRequiresApproval"],
        portalEnabled: json["portalEnabled"],
        taxiEnabled: json["taxiEnabled"],
    );

    Map<String, dynamic> toJson() => {
        "onlineBookingEnabled": onlineBookingEnabled,
        "onlineBookingRequiresApproval": onlineBookingRequiresApproval,
        "portalEnabled": portalEnabled,
        "taxiEnabled": taxiEnabled,
    };
}

class Tenant {
    final String name;
    final String slug;
    final String timezone;

    Tenant({
        required this.name,
        required this.slug,
        required this.timezone,
    });

    factory Tenant.fromJson(Map<String, dynamic> json) => Tenant(
        name: json["name"],
        slug: json["slug"],
        timezone: json["timezone"],
    );

    Map<String, dynamic> toJson() => {
        "name": name,
        "slug": slug,
        "timezone": timezone,
    };
}

class Tutor {
    final int balanceCents;
    final String id;
    final String name;
    final int petsCount;

    Tutor({
        required this.balanceCents,
        required this.id,
        required this.name,
        required this.petsCount,
    });

    factory Tutor.fromJson(Map<String, dynamic> json) => Tutor(
        balanceCents: json["balanceCents"],
        id: json["id"],
        name: json["name"],
        petsCount: json["petsCount"],
    );

    Map<String, dynamic> toJson() => {
        "balanceCents": balanceCents,
        "id": id,
        "name": name,
        "petsCount": petsCount,
    };
}

class PortalDeletionRequest {
    final String dueAt;
    final String id;
    final String requestedAt;
    final String? resolution;
    final String? respondedAt;
    final PortalDeletionRequestStatus status;

    PortalDeletionRequest({
        required this.dueAt,
        required this.id,
        required this.requestedAt,
        required this.resolution,
        required this.respondedAt,
        required this.status,
    });

    factory PortalDeletionRequest.fromJson(Map<String, dynamic> json) => PortalDeletionRequest(
        dueAt: json["dueAt"],
        id: json["id"],
        requestedAt: json["requestedAt"],
        resolution: json["resolution"],
        respondedAt: json["respondedAt"],
        status: portalDeletionRequestStatusValues.map[json["status"]]!,
    );

    Map<String, dynamic> toJson() => {
        "dueAt": dueAt,
        "id": id,
        "requestedAt": requestedAt,
        "resolution": resolution,
        "respondedAt": respondedAt,
        "status": portalDeletionRequestStatusValues.reverse[status],
    };
}

enum PortalDeletionRequestStatus {
    DONE,
    OPEN,
    REJECTED
}

final portalDeletionRequestStatusValues = EnumValues({
    "DONE": PortalDeletionRequestStatus.DONE,
    "OPEN": PortalDeletionRequestStatus.OPEN,
    "REJECTED": PortalDeletionRequestStatus.REJECTED
});

class PortalDeletionRequestInput {
    final String? reason;

    PortalDeletionRequestInput({
        this.reason,
    });

    factory PortalDeletionRequestInput.fromJson(Map<String, dynamic> json) => PortalDeletionRequestInput(
        reason: json["reason"],
    );

    Map<String, dynamic> toJson() => {
        "reason": reason,
    };
}

class PortalDevice {
    final PortalDevicePlatform platform;
    final String token;

    PortalDevice({
        required this.platform,
        required this.token,
    });

    factory PortalDevice.fromJson(Map<String, dynamic> json) => PortalDevice(
        platform: portalDevicePlatformValues.map[json["platform"]]!,
        token: json["token"],
    );

    Map<String, dynamic> toJson() => {
        "platform": portalDevicePlatformValues.reverse[platform],
        "token": token,
    };
}

enum PortalDevicePlatform {
    ANDROID,
    IOS
}

final portalDevicePlatformValues = EnumValues({
    "ANDROID": PortalDevicePlatform.ANDROID,
    "IOS": PortalDevicePlatform.IOS
});

class PortalDeviceForget {
    final String token;

    PortalDeviceForget({
        required this.token,
    });

    factory PortalDeviceForget.fromJson(Map<String, dynamic> json) => PortalDeviceForget(
        token: json["token"],
    );

    Map<String, dynamic> toJson() => {
        "token": token,
    };
}

class PortalDirectoryEntry {
    final String? brandColor;
    final String? logoUrl;
    final String name;
    final String slug;

    PortalDirectoryEntry({
        required this.brandColor,
        required this.logoUrl,
        required this.name,
        required this.slug,
    });

    factory PortalDirectoryEntry.fromJson(Map<String, dynamic> json) => PortalDirectoryEntry(
        brandColor: json["brandColor"],
        logoUrl: json["logoUrl"],
        name: json["name"],
        slug: json["slug"],
    );

    Map<String, dynamic> toJson() => {
        "brandColor": brandColor,
        "logoUrl": logoUrl,
        "name": name,
        "slug": slug,
    };
}

class PortalDirectoryResponse {
    final List<PortalDirectoryEntry> tenants;
    final bool truncated;

    PortalDirectoryResponse({
        required this.tenants,
        required this.truncated,
    });

    factory PortalDirectoryResponse.fromJson(Map<String, dynamic> json) => PortalDirectoryResponse(
        tenants: List<PortalDirectoryEntry>.from(json["tenants"].map((x) => PortalDirectoryEntry.fromJson(x))),
        truncated: json["truncated"],
    );

    Map<String, dynamic> toJson() => {
        "tenants": List<dynamic>.from(tenants.map((x) => x.toJson())),
        "truncated": truncated,
    };
}

class PortalDocument {
    final String id;
    final String? issuedAt;
    final PortalDocumentKind kind;
    final String number;
    final String? petName;
    final bool ready;

    PortalDocument({
        required this.id,
        required this.issuedAt,
        required this.kind,
        required this.number,
        required this.petName,
        required this.ready,
    });

    factory PortalDocument.fromJson(Map<String, dynamic> json) => PortalDocument(
        id: json["id"],
        issuedAt: json["issuedAt"],
        kind: portalDocumentKindValues.map[json["kind"]]!,
        number: json["number"],
        petName: json["petName"],
        ready: json["ready"],
    );

    Map<String, dynamic> toJson() => {
        "id": id,
        "issuedAt": issuedAt,
        "kind": portalDocumentKindValues.reverse[kind],
        "number": number,
        "petName": petName,
        "ready": ready,
    };
}

enum PortalDocumentKind {
    IMAGE_CONSENT,
    PRESCRIPTION,
    RECEIPT,
    TERM_ACCEPTANCE
}

final portalDocumentKindValues = EnumValues({
    "IMAGE_CONSENT": PortalDocumentKind.IMAGE_CONSENT,
    "PRESCRIPTION": PortalDocumentKind.PRESCRIPTION,
    "RECEIPT": PortalDocumentKind.RECEIPT,
    "TERM_ACCEPTANCE": PortalDocumentKind.TERM_ACCEPTANCE
});

class PortalDocumentsResponse {
    final List<PortalDocument> documents;

    PortalDocumentsResponse({
        required this.documents,
    });

    factory PortalDocumentsResponse.fromJson(Map<String, dynamic> json) => PortalDocumentsResponse(
        documents: List<PortalDocument>.from(json["documents"].map((x) => PortalDocument.fromJson(x))),
    );

    Map<String, dynamic> toJson() => {
        "documents": List<dynamic>.from(documents.map((x) => x.toJson())),
    };
}

class PortalFinanceResponse {
    final int balanceCents;
    final PortalPaymentInstructions howToPay;
    final String? oldestOpenDebitAt;
    final int openDebitsCents;
    final List<PortalPackage> packages;
    final String timezone;

    PortalFinanceResponse({
        required this.balanceCents,
        required this.howToPay,
        required this.oldestOpenDebitAt,
        required this.openDebitsCents,
        required this.packages,
        required this.timezone,
    });

    factory PortalFinanceResponse.fromJson(Map<String, dynamic> json) => PortalFinanceResponse(
        balanceCents: json["balanceCents"],
        howToPay: PortalPaymentInstructions.fromJson(json["howToPay"]),
        oldestOpenDebitAt: json["oldestOpenDebitAt"],
        openDebitsCents: json["openDebitsCents"],
        packages: List<PortalPackage>.from(json["packages"].map((x) => PortalPackage.fromJson(x))),
        timezone: json["timezone"],
    );

    Map<String, dynamic> toJson() => {
        "balanceCents": balanceCents,
        "howToPay": howToPay.toJson(),
        "oldestOpenDebitAt": oldestOpenDebitAt,
        "openDebitsCents": openDebitsCents,
        "packages": List<dynamic>.from(packages.map((x) => x.toJson())),
        "timezone": timezone,
    };
}

class PortalPaymentInstructions {
    final List<Hour> hours;
    final String? phone;
    final String? pixKey;
    final String? whatsapp;

    PortalPaymentInstructions({
        required this.hours,
        required this.phone,
        required this.pixKey,
        required this.whatsapp,
    });

    factory PortalPaymentInstructions.fromJson(Map<String, dynamic> json) => PortalPaymentInstructions(
        hours: List<Hour>.from(json["hours"].map((x) => Hour.fromJson(x))),
        phone: json["phone"],
        pixKey: json["pixKey"],
        whatsapp: json["whatsapp"],
    );

    Map<String, dynamic> toJson() => {
        "hours": List<dynamic>.from(hours.map((x) => x.toJson())),
        "phone": phone,
        "pixKey": pixKey,
        "whatsapp": whatsapp,
    };
}

class Hour {
    final String label;
    final String value;

    Hour({
        required this.label,
        required this.value,
    });

    factory Hour.fromJson(Map<String, dynamic> json) => Hour(
        label: json["label"],
        value: json["value"],
    );

    Map<String, dynamic> toJson() => {
        "label": label,
        "value": value,
    };
}

class PortalPackage {
    final int creditsRemaining;
    final int creditsTotal;
    final String expiresAt;
    final bool expiringSoon;
    final String id;
    final String name;
    final String? petName;

    PortalPackage({
        required this.creditsRemaining,
        required this.creditsTotal,
        required this.expiresAt,
        required this.expiringSoon,
        required this.id,
        required this.name,
        required this.petName,
    });

    factory PortalPackage.fromJson(Map<String, dynamic> json) => PortalPackage(
        creditsRemaining: json["creditsRemaining"],
        creditsTotal: json["creditsTotal"],
        expiresAt: json["expiresAt"],
        expiringSoon: json["expiringSoon"],
        id: json["id"],
        name: json["name"],
        petName: json["petName"],
    );

    Map<String, dynamic> toJson() => {
        "creditsRemaining": creditsRemaining,
        "creditsTotal": creditsTotal,
        "expiresAt": expiresAt,
        "expiringSoon": expiringSoon,
        "id": id,
        "name": name,
        "petName": petName,
    };
}

class PortalMeDataResponse {
    final List<PortalAddress> addresses;
    final PortalDeletionRequest? deletionRequest;
    final PendingContact? pendingContact;
    final PortalProfile profile;

    PortalMeDataResponse({
        required this.addresses,
        required this.deletionRequest,
        required this.pendingContact,
        required this.profile,
    });

    factory PortalMeDataResponse.fromJson(Map<String, dynamic> json) => PortalMeDataResponse(
        addresses: List<PortalAddress>.from(json["addresses"].map((x) => PortalAddress.fromJson(x))),
        deletionRequest: json["deletionRequest"] == null ? null : PortalDeletionRequest.fromJson(json["deletionRequest"]),
        pendingContact: json["pendingContact"] == null ? null : PendingContact.fromJson(json["pendingContact"]),
        profile: PortalProfile.fromJson(json["profile"]),
    );

    Map<String, dynamic> toJson() => {
        "addresses": List<dynamic>.from(addresses.map((x) => x.toJson())),
        "deletionRequest": deletionRequest?.toJson(),
        "pendingContact": pendingContact?.toJson(),
        "profile": profile.toJson(),
    };
}

class PendingContact {
    final String expiresAt;
    final PortalContactField field;
    final String id;
    final String maskedTarget;

    PendingContact({
        required this.expiresAt,
        required this.field,
        required this.id,
        required this.maskedTarget,
    });

    factory PendingContact.fromJson(Map<String, dynamic> json) => PendingContact(
        expiresAt: json["expiresAt"],
        field: portalContactFieldValues.map[json["field"]]!,
        id: json["id"],
        maskedTarget: json["maskedTarget"],
    );

    Map<String, dynamic> toJson() => {
        "expiresAt": expiresAt,
        "field": portalContactFieldValues.reverse[field],
        "id": id,
        "maskedTarget": maskedTarget,
    };
}

class PortalProfile {
    final String? birthDate;
    final String? cnpjMasked;
    final String? cpfMasked;
    final String displayName;
    final String? email;
    final String fullName;
    final String phoneMasked;
    final String? socialName;

    PortalProfile({
        required this.birthDate,
        required this.cnpjMasked,
        required this.cpfMasked,
        required this.displayName,
        required this.email,
        required this.fullName,
        required this.phoneMasked,
        required this.socialName,
    });

    factory PortalProfile.fromJson(Map<String, dynamic> json) => PortalProfile(
        birthDate: json["birthDate"],
        cnpjMasked: json["cnpjMasked"],
        cpfMasked: json["cpfMasked"],
        displayName: json["displayName"],
        email: json["email"],
        fullName: json["fullName"],
        phoneMasked: json["phoneMasked"],
        socialName: json["socialName"],
    );

    Map<String, dynamic> toJson() => {
        "birthDate": birthDate,
        "cnpjMasked": cnpjMasked,
        "cpfMasked": cpfMasked,
        "displayName": displayName,
        "email": email,
        "fullName": fullName,
        "phoneMasked": phoneMasked,
        "socialName": socialName,
    };
}

class PortalMessage {
    final String body;
    final Category category;
    final PortalChannel channel;
    final String id;
    final String sentAt;
    final String? subject;

    PortalMessage({
        required this.body,
        required this.category,
        required this.channel,
        required this.id,
        required this.sentAt,
        required this.subject,
    });

    factory PortalMessage.fromJson(Map<String, dynamic> json) => PortalMessage(
        body: json["body"],
        category: categoryValues.map[json["category"]]!,
        channel: portalChannelValues.map[json["channel"]]!,
        id: json["id"],
        sentAt: json["sentAt"],
        subject: json["subject"],
    );

    Map<String, dynamic> toJson() => {
        "body": body,
        "category": categoryValues.reverse[category],
        "channel": portalChannelValues.reverse[channel],
        "id": id,
        "sentAt": sentAt,
        "subject": subject,
    };
}

enum Category {
    MARKETING,
    OPERATIONAL,
    TRANSACTIONAL
}

final categoryValues = EnumValues({
    "MARKETING": Category.MARKETING,
    "OPERATIONAL": Category.OPERATIONAL,
    "TRANSACTIONAL": Category.TRANSACTIONAL
});

class PortalMessagesResponse {
    final int limit;
    final List<PortalMessage> messages;
    final int page;
    final String timezone;
    final int total;

    PortalMessagesResponse({
        required this.limit,
        required this.messages,
        required this.page,
        required this.timezone,
        required this.total,
    });

    factory PortalMessagesResponse.fromJson(Map<String, dynamic> json) => PortalMessagesResponse(
        limit: json["limit"],
        messages: List<PortalMessage>.from(json["messages"].map((x) => PortalMessage.fromJson(x))),
        page: json["page"],
        timezone: json["timezone"],
        total: json["total"],
    );

    Map<String, dynamic> toJson() => {
        "limit": limit,
        "messages": List<dynamic>.from(messages.map((x) => x.toJson())),
        "page": page,
        "timezone": timezone,
        "total": total,
    };
}

class PortalNextAppointment {
    final String id;
    final List<String> services;
    final String startsAt;
    final String status;

    PortalNextAppointment({
        required this.id,
        required this.services,
        required this.startsAt,
        required this.status,
    });

    factory PortalNextAppointment.fromJson(Map<String, dynamic> json) => PortalNextAppointment(
        id: json["id"],
        services: List<String>.from(json["services"].map((x) => x)),
        startsAt: json["startsAt"],
        status: json["status"],
    );

    Map<String, dynamic> toJson() => {
        "id": id,
        "services": List<dynamic>.from(services.map((x) => x)),
        "startsAt": startsAt,
        "status": status,
    };
}

class PortalPetAlert {
    final PortalPetAlertKind kind;
    final String label;
    final Severity severity;

    PortalPetAlert({
        required this.kind,
        required this.label,
        required this.severity,
    });

    factory PortalPetAlert.fromJson(Map<String, dynamic> json) => PortalPetAlert(
        kind: portalPetAlertKindValues.map[json["kind"]]!,
        label: json["label"],
        severity: severityValues.map[json["severity"]]!,
    );

    Map<String, dynamic> toJson() => {
        "kind": portalPetAlertKindValues.reverse[kind],
        "label": label,
        "severity": severityValues.reverse[severity],
    };
}

enum PortalPetAlertKind {
    ALLERGY,
    MEDICAL
}

final portalPetAlertKindValues = EnumValues({
    "ALLERGY": PortalPetAlertKind.ALLERGY,
    "MEDICAL": PortalPetAlertKind.MEDICAL
});

enum Severity {
    CRITICAL,
    HIGH,
    LOW,
    MEDIUM
}

final severityValues = EnumValues({
    "CRITICAL": Severity.CRITICAL,
    "HIGH": Severity.HIGH,
    "LOW": Severity.LOW,
    "MEDIUM": Severity.MEDIUM
});

class PortalPetDetail {
    final String? ageLabel;
    final List<PortalPetAlert> alerts;
    final String? birthDate;
    final BirthDatePrecision birthDatePrecision;
    final String? breed;
    final String? coat;
    final String? color;
    final String id;
    final bool inMemoriam;
    final String? lastAttendanceAt;
    final String name;
    final bool? neutered;
    final PortalNextAppointment? nextAppointment;
    final String? notes;
    final String? photoUrl;
    final Sex sex;
    final String size;
    final String species;
    final double? weightKg;

    PortalPetDetail({
        required this.ageLabel,
        required this.alerts,
        required this.birthDate,
        required this.birthDatePrecision,
        required this.breed,
        required this.coat,
        required this.color,
        required this.id,
        required this.inMemoriam,
        required this.lastAttendanceAt,
        required this.name,
        required this.neutered,
        required this.nextAppointment,
        required this.notes,
        required this.photoUrl,
        required this.sex,
        required this.size,
        required this.species,
        required this.weightKg,
    });

    factory PortalPetDetail.fromJson(Map<String, dynamic> json) => PortalPetDetail(
        ageLabel: json["ageLabel"],
        alerts: List<PortalPetAlert>.from(json["alerts"].map((x) => PortalPetAlert.fromJson(x))),
        birthDate: json["birthDate"],
        birthDatePrecision: birthDatePrecisionValues.map[json["birthDatePrecision"]]!,
        breed: json["breed"],
        coat: json["coat"],
        color: json["color"],
        id: json["id"],
        inMemoriam: json["inMemoriam"],
        lastAttendanceAt: json["lastAttendanceAt"],
        name: json["name"],
        neutered: json["neutered"],
        nextAppointment: json["nextAppointment"] == null ? null : PortalNextAppointment.fromJson(json["nextAppointment"]),
        notes: json["notes"],
        photoUrl: json["photoUrl"],
        sex: sexValues.map[json["sex"]]!,
        size: json["size"],
        species: json["species"],
        weightKg: json["weightKg"]?.toDouble(),
    );

    Map<String, dynamic> toJson() => {
        "ageLabel": ageLabel,
        "alerts": List<dynamic>.from(alerts.map((x) => x.toJson())),
        "birthDate": birthDate,
        "birthDatePrecision": birthDatePrecisionValues.reverse[birthDatePrecision],
        "breed": breed,
        "coat": coat,
        "color": color,
        "id": id,
        "inMemoriam": inMemoriam,
        "lastAttendanceAt": lastAttendanceAt,
        "name": name,
        "neutered": neutered,
        "nextAppointment": nextAppointment?.toJson(),
        "notes": notes,
        "photoUrl": photoUrl,
        "sex": sexValues.reverse[sex],
        "size": size,
        "species": species,
        "weightKg": weightKg,
    };
}

enum BirthDatePrecision {
    ESTIMATED,
    EXACT,
    UNKNOWN
}

final birthDatePrecisionValues = EnumValues({
    "ESTIMATED": BirthDatePrecision.ESTIMATED,
    "EXACT": BirthDatePrecision.EXACT,
    "UNKNOWN": BirthDatePrecision.UNKNOWN
});

enum Sex {
    FEMALE,
    MALE,
    UNKNOWN
}

final sexValues = EnumValues({
    "FEMALE": Sex.FEMALE,
    "MALE": Sex.MALE,
    "UNKNOWN": Sex.UNKNOWN
});

class PortalPetSummary {
    final String? ageLabel;
    final String? breed;
    final String id;
    final bool inMemoriam;
    final String? lastAttendanceAt;
    final String name;
    final PortalNextAppointment? nextAppointment;
    final String? photoUrl;
    final String species;

    PortalPetSummary({
        required this.ageLabel,
        required this.breed,
        required this.id,
        required this.inMemoriam,
        required this.lastAttendanceAt,
        required this.name,
        required this.nextAppointment,
        required this.photoUrl,
        required this.species,
    });

    factory PortalPetSummary.fromJson(Map<String, dynamic> json) => PortalPetSummary(
        ageLabel: json["ageLabel"],
        breed: json["breed"],
        id: json["id"],
        inMemoriam: json["inMemoriam"],
        lastAttendanceAt: json["lastAttendanceAt"],
        name: json["name"],
        nextAppointment: json["nextAppointment"] == null ? null : PortalNextAppointment.fromJson(json["nextAppointment"]),
        photoUrl: json["photoUrl"],
        species: json["species"],
    );

    Map<String, dynamic> toJson() => {
        "ageLabel": ageLabel,
        "breed": breed,
        "id": id,
        "inMemoriam": inMemoriam,
        "lastAttendanceAt": lastAttendanceAt,
        "name": name,
        "nextAppointment": nextAppointment?.toJson(),
        "photoUrl": photoUrl,
        "species": species,
    };
}

class PortalPreferencesResponse {
    final List<PortalChannel> availableChannels;
    final List<PortalChannelPreference> marketing;

    PortalPreferencesResponse({
        required this.availableChannels,
        required this.marketing,
    });

    factory PortalPreferencesResponse.fromJson(Map<String, dynamic> json) => PortalPreferencesResponse(
        availableChannels: List<PortalChannel>.from(json["availableChannels"].map((x) => portalChannelValues.map[x]!)),
        marketing: List<PortalChannelPreference>.from(json["marketing"].map((x) => PortalChannelPreference.fromJson(x))),
    );

    Map<String, dynamic> toJson() => {
        "availableChannels": List<dynamic>.from(availableChannels.map((x) => portalChannelValues.reverse[x])),
        "marketing": List<dynamic>.from(marketing.map((x) => x.toJson())),
    };
}

class PortalReceiptResponse {
    final String? issuedAt;
    final String number;
    final String status;
    final String? url;

    PortalReceiptResponse({
        required this.issuedAt,
        required this.number,
        required this.status,
        required this.url,
    });

    factory PortalReceiptResponse.fromJson(Map<String, dynamic> json) => PortalReceiptResponse(
        issuedAt: json["issuedAt"],
        number: json["number"],
        status: json["status"],
        url: json["url"],
    );

    Map<String, dynamic> toJson() => {
        "issuedAt": issuedAt,
        "number": number,
        "status": status,
        "url": url,
    };
}

class PortalReschedule {
    final String professionalId;
    final DateTime startsAt;

    PortalReschedule({
        required this.professionalId,
        required this.startsAt,
    });

    factory PortalReschedule.fromJson(Map<String, dynamic> json) => PortalReschedule(
        professionalId: json["professionalId"],
        startsAt: DateTime.parse(json["startsAt"]),
    );

    Map<String, dynamic> toJson() => {
        "professionalId": professionalId,
        "startsAt": startsAt.toIso8601String(),
    };
}

class PortalStatementEntry {
    final int amountCents;
    final String category;
    final String description;
    final String id;
    final String occurredAt;
    final String? paymentId;
    final String? petName;
    final bool reversed;

    PortalStatementEntry({
        required this.amountCents,
        required this.category,
        required this.description,
        required this.id,
        required this.occurredAt,
        required this.paymentId,
        required this.petName,
        required this.reversed,
    });

    factory PortalStatementEntry.fromJson(Map<String, dynamic> json) => PortalStatementEntry(
        amountCents: json["amountCents"],
        category: json["category"],
        description: json["description"],
        id: json["id"],
        occurredAt: json["occurredAt"],
        paymentId: json["paymentId"],
        petName: json["petName"],
        reversed: json["reversed"],
    );

    Map<String, dynamic> toJson() => {
        "amountCents": amountCents,
        "category": category,
        "description": description,
        "id": id,
        "occurredAt": occurredAt,
        "paymentId": paymentId,
        "petName": petName,
        "reversed": reversed,
    };
}

class PortalStatementResponse {
    final int balanceCents;
    final List<PortalStatementEntry> entries;
    final int limit;
    final int page;
    final String timezone;
    final int total;

    PortalStatementResponse({
        required this.balanceCents,
        required this.entries,
        required this.limit,
        required this.page,
        required this.timezone,
        required this.total,
    });

    factory PortalStatementResponse.fromJson(Map<String, dynamic> json) => PortalStatementResponse(
        balanceCents: json["balanceCents"],
        entries: List<PortalStatementEntry>.from(json["entries"].map((x) => PortalStatementEntry.fromJson(x))),
        limit: json["limit"],
        page: json["page"],
        timezone: json["timezone"],
        total: json["total"],
    );

    Map<String, dynamic> toJson() => {
        "balanceCents": balanceCents,
        "entries": List<dynamic>.from(entries.map((x) => x.toJson())),
        "limit": limit,
        "page": page,
        "timezone": timezone,
        "total": total,
    };
}

class PortalTaxiOffer {
    final Address? address;
    final bool available;
    final String? message;
    final int? priceCentsPerLeg;
    final PortalTaxiUnavailableReason? reason;
    final int windowMinutes;

    PortalTaxiOffer({
        required this.address,
        required this.available,
        required this.message,
        required this.priceCentsPerLeg,
        required this.reason,
        required this.windowMinutes,
    });

    factory PortalTaxiOffer.fromJson(Map<String, dynamic> json) => PortalTaxiOffer(
        address: json["address"] == null ? null : Address.fromJson(json["address"]),
        available: json["available"],
        message: json["message"],
        priceCentsPerLeg: json["priceCentsPerLeg"],
        reason: portalTaxiUnavailableReasonValues.map[json["reason"]],
        windowMinutes: json["windowMinutes"],
    );

    Map<String, dynamic> toJson() => {
        "address": address?.toJson(),
        "available": available,
        "message": message,
        "priceCentsPerLeg": priceCentsPerLeg,
        "reason": portalTaxiUnavailableReasonValues.reverse[reason],
        "windowMinutes": windowMinutes,
    };
}

class Address {
    final String label;
    final String zipCode;

    Address({
        required this.label,
        required this.zipCode,
    });

    factory Address.fromJson(Map<String, dynamic> json) => Address(
        label: json["label"],
        zipCode: json["zipCode"],
    );

    Map<String, dynamic> toJson() => {
        "label": label,
        "zipCode": zipCode,
    };
}

enum PortalTaxiUnavailableReason {
    DISABLED,
    NOT_CONFIGURED,
    NO_ADDRESS,
    OUT_OF_AREA,
    UNAVAILABLE
}

final portalTaxiUnavailableReasonValues = EnumValues({
    "DISABLED": PortalTaxiUnavailableReason.DISABLED,
    "NOT_CONFIGURED": PortalTaxiUnavailableReason.NOT_CONFIGURED,
    "NO_ADDRESS": PortalTaxiUnavailableReason.NO_ADDRESS,
    "OUT_OF_AREA": PortalTaxiUnavailableReason.OUT_OF_AREA,
    "UNAVAILABLE": PortalTaxiUnavailableReason.UNAVAILABLE
});

class PortalTenantResponse {
    final String? brandColor;
    final String? logoUrl;
    final String name;
    final bool portalEnabled;
    final String slug;

    PortalTenantResponse({
        required this.brandColor,
        required this.logoUrl,
        required this.name,
        required this.portalEnabled,
        required this.slug,
    });

    factory PortalTenantResponse.fromJson(Map<String, dynamic> json) => PortalTenantResponse(
        brandColor: json["brandColor"],
        logoUrl: json["logoUrl"],
        name: json["name"],
        portalEnabled: json["portalEnabled"],
        slug: json["slug"],
    );

    Map<String, dynamic> toJson() => {
        "brandColor": brandColor,
        "logoUrl": logoUrl,
        "name": name,
        "portalEnabled": portalEnabled,
        "slug": slug,
    };
}

class PortalTerm {
    final bool accepted;
    final String? acceptedVersion;
    final String body;
    final PortalTermKind kind;
    final String title;
    final String version;

    PortalTerm({
        required this.accepted,
        required this.acceptedVersion,
        required this.body,
        required this.kind,
        required this.title,
        required this.version,
    });

    factory PortalTerm.fromJson(Map<String, dynamic> json) => PortalTerm(
        accepted: json["accepted"],
        acceptedVersion: json["acceptedVersion"],
        body: json["body"],
        kind: portalTermKindValues.map[json["kind"]]!,
        title: json["title"],
        version: json["version"],
    );

    Map<String, dynamic> toJson() => {
        "accepted": accepted,
        "acceptedVersion": acceptedVersion,
        "body": body,
        "kind": portalTermKindValues.reverse[kind],
        "title": title,
        "version": version,
    };
}

enum PortalTermKind {
    IMAGE_USE,
    SERVICE_LIABILITY,
    TERMS
}

final portalTermKindValues = EnumValues({
    "IMAGE_USE": PortalTermKind.IMAGE_USE,
    "SERVICE_LIABILITY": PortalTermKind.SERVICE_LIABILITY,
    "TERMS": PortalTermKind.TERMS
});

class PortalTermsResponse {
    final List<PortalTerm> terms;

    PortalTermsResponse({
        required this.terms,
    });

    factory PortalTermsResponse.fromJson(Map<String, dynamic> json) => PortalTermsResponse(
        terms: List<PortalTerm>.from(json["terms"].map((x) => PortalTerm.fromJson(x))),
    );

    Map<String, dynamic> toJson() => {
        "terms": List<dynamic>.from(terms.map((x) => x.toJson())),
    };
}

class PortalTimelineEntry {
    final String? finishedAt;
    final String id;
    final List<String> notes;
    final List<String> photoUrls;
    final String? professional;
    final List<String> services;
    final String startedAt;
    final String type;
    final String? voidedAt;
    final double? weightKg;

    PortalTimelineEntry({
        required this.finishedAt,
        required this.id,
        required this.notes,
        required this.photoUrls,
        required this.professional,
        required this.services,
        required this.startedAt,
        required this.type,
        required this.voidedAt,
        required this.weightKg,
    });

    factory PortalTimelineEntry.fromJson(Map<String, dynamic> json) => PortalTimelineEntry(
        finishedAt: json["finishedAt"],
        id: json["id"],
        notes: List<String>.from(json["notes"].map((x) => x)),
        photoUrls: List<String>.from(json["photoUrls"].map((x) => x)),
        professional: json["professional"],
        services: List<String>.from(json["services"].map((x) => x)),
        startedAt: json["startedAt"],
        type: json["type"],
        voidedAt: json["voidedAt"],
        weightKg: json["weightKg"]?.toDouble(),
    );

    Map<String, dynamic> toJson() => {
        "finishedAt": finishedAt,
        "id": id,
        "notes": List<dynamic>.from(notes.map((x) => x)),
        "photoUrls": List<dynamic>.from(photoUrls.map((x) => x)),
        "professional": professional,
        "services": List<dynamic>.from(services.map((x) => x)),
        "startedAt": startedAt,
        "type": type,
        "voidedAt": voidedAt,
        "weightKg": weightKg,
    };
}

class PortalTimelineResponse {
    final List<PortalTimelineEntry> entries;
    final String? nextCursor;

    PortalTimelineResponse({
        required this.entries,
        required this.nextCursor,
    });

    factory PortalTimelineResponse.fromJson(Map<String, dynamic> json) => PortalTimelineResponse(
        entries: List<PortalTimelineEntry>.from(json["entries"].map((x) => PortalTimelineEntry.fromJson(x))),
        nextCursor: json["nextCursor"],
    );

    Map<String, dynamic> toJson() => {
        "entries": List<dynamic>.from(entries.map((x) => x.toJson())),
        "nextCursor": nextCursor,
    };
}

class PortalVerify {
    final String challengeId;
    final String code;

    PortalVerify({
        required this.challengeId,
        required this.code,
    });

    factory PortalVerify.fromJson(Map<String, dynamic> json) => PortalVerify(
        challengeId: json["challengeId"],
        code: json["code"],
    );

    Map<String, dynamic> toJson() => {
        "challengeId": challengeId,
        "code": code,
    };
}

class UpdateOwnPet {
    final DateTime? birthDate;
    final String? name;
    final bool? neutered;
    final String? notes;

    UpdateOwnPet({
        this.birthDate,
        this.name,
        this.neutered,
        this.notes,
    });

    factory UpdateOwnPet.fromJson(Map<String, dynamic> json) => UpdateOwnPet(
        birthDate: json["birthDate"] == null ? null : DateTime.parse(json["birthDate"]),
        name: json["name"],
        neutered: json["neutered"],
        notes: json["notes"],
    );

    Map<String, dynamic> toJson() => {
        "birthDate": birthDate == null ? null : "${birthDate!.year.toString().padLeft(4, '0')}-${birthDate!.month.toString().padLeft(2, '0')}-${birthDate!.day.toString().padLeft(2, '0')}",
        "name": name,
        "neutered": neutered,
        "notes": notes,
    };
}

class UpdateOwnTutor {
    final DateTime? birthDate;
    final String? socialName;

    UpdateOwnTutor({
        this.birthDate,
        this.socialName,
    });

    factory UpdateOwnTutor.fromJson(Map<String, dynamic> json) => UpdateOwnTutor(
        birthDate: json["birthDate"] == null ? null : DateTime.parse(json["birthDate"]),
        socialName: json["socialName"],
    );

    Map<String, dynamic> toJson() => {
        "birthDate": birthDate == null ? null : "${birthDate!.year.toString().padLeft(4, '0')}-${birthDate!.month.toString().padLeft(2, '0')}-${birthDate!.day.toString().padLeft(2, '0')}",
        "socialName": socialName,
    };
}

class UpdatePortalAddress {
    final String? accessNotes;
    final String? city;
    final String? complement;
    final String? district;
    final bool? isPrimary;
    final String? label;
    final String? number;
    final String? state;
    final String? street;
    final String? zipCode;

    UpdatePortalAddress({
        this.accessNotes,
        this.city,
        this.complement,
        this.district,
        this.isPrimary,
        this.label,
        this.number,
        this.state,
        this.street,
        this.zipCode,
    });

    factory UpdatePortalAddress.fromJson(Map<String, dynamic> json) => UpdatePortalAddress(
        accessNotes: json["accessNotes"],
        city: json["city"],
        complement: json["complement"],
        district: json["district"],
        isPrimary: json["isPrimary"],
        label: json["label"],
        number: json["number"],
        state: json["state"],
        street: json["street"],
        zipCode: json["zipCode"],
    );

    Map<String, dynamic> toJson() => {
        "accessNotes": accessNotes,
        "city": city,
        "complement": complement,
        "district": district,
        "isPrimary": isPrimary,
        "label": label,
        "number": number,
        "state": state,
        "street": street,
        "zipCode": zipCode,
    };
}

class UpdatePortalPreference {
    final PortalChannel channel;
    final bool granted;

    UpdatePortalPreference({
        required this.channel,
        required this.granted,
    });

    factory UpdatePortalPreference.fromJson(Map<String, dynamic> json) => UpdatePortalPreference(
        channel: portalChannelValues.map[json["channel"]]!,
        granted: json["granted"],
    );

    Map<String, dynamic> toJson() => {
        "channel": portalChannelValues.reverse[channel],
        "granted": granted,
    };
}

class EnumValues<T> {
    Map<String, T> map;
    late Map<T, String> reverseMap;

    EnumValues(this.map);

    Map<T, String> get reverse {
            reverseMap = map.map((k, v) => MapEntry(v, k));
            return reverseMap;
    }
}
