// Wix Bookings API client.

const { randomUUID } = require('crypto');
const cfg = require('./config');
const { getMemberAuth, getToken } = require('./auth');
const logger = require('./logger');

const AVAILABILITY_PATH = '/_api/service-availability/v2/time-slots/event';
const ACTIVE_BOOKINGS_PATH = '/_api/bookings-reader/v2/extended-bookings/query';
const BOOKING_PATH = '/_api/bookings-service/v2/bulk/bookings/create';
const CHECKOUT_PATH = '/ecom/v1/checkouts';
const MEMBERSHIP_ELIGIBILITY_PATH = '/memberships-spi-host/v1/list-eligible-memberships';
const NO_ELIGIBLE_MEMBERSHIP = 'NO_ELIGIBLE_MEMBERSHIP';

async function resolveBookingUser(bookingUser) {
  const member = await fetchMember(bookingUser);
  const fetchedProfile = extractProfile(member, bookingUser);

  const resolvedUser = {
    ...bookingUser,
    name: firstDefined(
      bookingUser.name,
      [fetchedProfile.firstName, fetchedProfile.lastName].filter(Boolean).join(' '),
      fetchedProfile.email,
      bookingUser.account.email
    ),
    profile: {
      ...fetchedProfile,
      ...bookingUser.profile,
      email: bookingUser.profile?.email ?? fetchedProfile.email ?? bookingUser.account.email,
      phone: normalizePhone(bookingUser.profile?.phone ?? fetchedProfile.phone),
      contactId: bookingUser.profile?.contactId ?? fetchedProfile.contactId ?? fetchedProfile.memberId,
      memberId: bookingUser.profile?.memberId ?? fetchedProfile.memberId ?? fetchedProfile.contactId,
    },
  };

  assertResolvedUser(resolvedUser);
  return resolvedUser;
}

async function getAvailableSlots(bookingUser) {
  const services = getConfiguredServices();
  const { fromLocalDate, toLocalDate } = buildAvailabilityWindow();

  logger.info(`📅  Querying slots: ${fromLocalDate} → ${toLocalDate}`);
  logger.info(`  User: ${formatUser(bookingUser)}`);
  logger.info(`  Services: ${services.map(formatServiceName).join(', ')}`);

  const slotsByService = [];

  for (const service of services) {
    const slots = await fetchServiceSlots(bookingUser, service, fromLocalDate, toLocalDate);
    slotsByService.push(...slots.map(slot => ({ slot, service })));
  }

  const bookable = slotsByService.filter(({ slot }) => slot.bookable === true);
  logger.info(`  Total bookable across services: ${bookable.length}`);

  return bookable.map(normalizeSlot);
}

async function getActiveReservationDates(bookingUser) {
  logger.info(`📖  Querying active reservations for ${formatUser(bookingUser)}`);

  const data = await wixPost(
    bookingUser,
    ACTIVE_BOOKINGS_PATH,
    buildActiveBookingsPayload(bookingUser)
  );
  const bookings = extractActiveBookings(data);
  const dateKeys = new Set(
    bookings
      .map(booking => getBookingStartDate(booking))
      .filter(Boolean)
      .map(toIstanbulDateKey)
  );

  logger.info(`  Active reservations: ${bookings.length}`);
  if (dateKeys.size > 0) {
    logger.info(`  Reserved days: ${Array.from(dateKeys).sort().join(', ')}`);
  }

  return dateKeys;
}

async function createBooking(slot, bookingUser) {
  assertBookableSlot(slot);

  logger.info(`📝  Creating booking → ${slot.startDate} (${slot.serviceName ?? slot.serviceId})`);

  const data = await wixPost(bookingUser, BOOKING_PATH, buildBookingPayload(slot, bookingUser));
  const result = data?.results?.[0];

  if (!result?.itemMetadata?.success || !result?.item?.id) {
    throw new Error(`Booking failed: ${JSON.stringify(result)}`);
  }

  logger.info(`  ✅  bookingId: ${result.item.id}`);
  return result.item.id;
}

async function createCheckout(bookingId, bookingUser, slot) {
  logger.info(`🛒  Creating checkout → bookingId: ${bookingId}`);

  const membership = await resolveMembership(bookingUser, slot);
  const data = await wixPost(
    bookingUser,
    CHECKOUT_PATH,
    buildCheckoutPayload(bookingId, bookingUser, membership)
  );
  const checkoutId = data?.checkout?.id;

  if (!checkoutId) {
    throw new Error(`Checkout failed: ${JSON.stringify(data)}`);
  }

  logger.info(`  ✅  checkoutId: ${checkoutId}`);
  return checkoutId;
}

async function createOrder(checkoutId, bookingUser) {
  logger.info(`📦  Creating order → checkoutId: ${checkoutId}`);

  const data = await wixPost(bookingUser, `${CHECKOUT_PATH}/${checkoutId}/create-order`, {
    id: checkoutId,
  });
  const orderId = data?.orderId;

  if (!orderId) {
    throw new Error(`Order failed: ${JSON.stringify(data)}`);
  }

  logger.info(`  🎉  orderId: ${orderId}`);
  return orderId;
}

async function fetchServiceSlots(bookingUser, service, fromLocalDate, toLocalDate) {
  logger.info(`  Checking service: ${formatServiceName(service)}`);

  const data = await wixPost(bookingUser, AVAILABILITY_PATH, {
    timeZone: cfg.wix.timezone,
    fromLocalDate,
    toLocalDate,
    serviceIds: [service.id],
    maxSlotsPerDay: 50,
    includeNonBookable: true,
    eventFilter: {},
    cursorPaging: { limit: 1000 },
  });

  const slots = data?.timeSlots ?? [];
  const bookable = slots.filter(slot => slot.bookable === true);

  logger.info(`    Total slots in window: ${slots.length}`);
  logger.info(`    Bookable now:          ${bookable.length}`);
  logUpcomingSlots(slots);

  return slots;
}

async function resolveMembership(bookingUser, slot) {
  if (bookingUser.membership?.id && bookingUser.membership?.appId) {
    return bookingUser.membership;
  }

  logger.info(`🎟️  Fetching eligible memberships for ${slot.serviceName ?? slot.serviceId}`);

  const data = await wixPost(
    bookingUser,
    MEMBERSHIP_ELIGIBILITY_PATH,
    buildEligibleMembershipsPayload(slot)
  );
  const membership = extractEligibleMembership(data, bookingUser);

  if (!membership?.id || !membership?.appId) {
    const err = new Error(`No eligible membership found for ${formatUser(bookingUser)} and ${slot.serviceName ?? slot.serviceId}`);
    err.code = NO_ELIGIBLE_MEMBERSHIP;
    throw err;
  }

  logger.info(`  ✅  membershipId: ${membership.id}`);
  return membership;
}

async function getEligibleMembership(bookingUser, slot) {
  return resolveMembership(bookingUser, slot);
}

async function wixPost(bookingUser, path, body) {
  const token = await getToken(bookingUser);
  const url = `${cfg.wix.baseUrl}${path}`;

  logger.info(`  → POST ${path}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      authorization: token,
      'x-wix-brand': 'wix',
      'x-wix-linguist': `tr|tr-tr|true|${cfg.wix.instanceId}`,
      commonconfig: buildCommonConfig(),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${path}: ${text}`);
  }

  return parseJsonOrText(text);
}

async function wixGet(bookingUser, path) {
  const token = await getToken(bookingUser);
  const url = `${cfg.wix.baseUrl}${path}`;

  logger.info(`  → GET ${path.split('?')[0]}`);

  const res = await fetch(url, {
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: token,
      'x-wix-brand': 'wix',
      'x-wix-linguist': `tr|tr-tr|true|${cfg.wix.instanceId}`,
      commonconfig: buildCommonConfig(),
    },
  });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${path}: ${text}`);
  }

  return parseJsonOrText(text);
}

async function fetchMember(bookingUser) {
  const { memberId } = await getMemberAuth(bookingUser);

  if (!memberId) {
    throw new Error(`Could not resolve member id for ${formatUser(bookingUser)}`);
  }

  logger.info(`👤  Fetching member profile: ${memberId}`);

  return wixGet(
    bookingUser,
    `/_api/members/v1/members/${memberId}?id=${memberId}&fieldsets=FULL`
  );
}

function buildAvailabilityWindow() {
  const now = new Date();
  const later = new Date(now);
  later.setDate(later.getDate() + cfg.session.lookAheadDays);

  return {
    fromLocalDate: toLocalDateTime(now),
    toLocalDate: toLocalDateTime(later, true),
  };
}

function buildBookingPayload(slot, bookingUser) {
  const profile = bookingUser.profile;

  return {
    returnFullEntity: true,
    createBookingsInfo: [{
      formSubmission: {
        first_name: `${profile.firstName} ${profile.lastName}`,
        email: profile.email,
        phone: profile.phone,
        address: null,
        add_your_message: null,
      },
      booking: {
        contactDetails: { contactId: profile.contactId },
        v2Availability: false,
        numberOfParticipants: 1,
        bookingSource: { actor: 'CUSTOMER', platform: 'WEB' },
        selectedPaymentOption: 'MEMBERSHIP',
        bookedEntity: {
          slot: {
            startDate: slot.startDate,
            endDate: slot.endDate,
            timezone: cfg.wix.timezone,
            location: buildLocation(),
            resource: { id: cfg.wix.resourceId, name: 'Personel #1' },
            serviceId: slot.serviceId,
            eventId: slot.eventId,
          },
        },
        depositSelected: null,
      },
      participantNotification: {
        notifyParticipants: true,
        metadata: { channels: 'EMAIL,SMS' },
      },
      sendSmsReminder: true,
    }],
  };
}

function buildCheckoutPayload(bookingId, bookingUser, membership) {
  const lineItemId = randomUUID();
  const { profile } = bookingUser;
  const contactDetails = {
    contactId: profile.contactId,
    firstName: profile.firstName,
    lastName: profile.lastName,
    email: profile.email,
    phone: profile.phone,
  };

  return {
    channelType: 'WEB',
    lineItems: [{
      quantity: 1,
      id: lineItemId,
      catalogReference: {
        catalogItemId: bookingId,
        appId: cfg.wix.appId,
      },
    }],
    checkoutInfo: {
      businessLocationId: cfg.wix.businessLocationId,
      billingInfo: { contactDetails },
      shippingInfo: { shippingDestination: { contactDetails } },
      buyerInfo: {
        email: profile.email,
        contactId: profile.contactId,
      },
      membershipOptions: {
        selectedMemberships: {
          memberships: [{
            id: membership.id,
            appId: membership.appId,
            lineItemIds: [lineItemId],
          }],
        },
      },
    },
  };
}

function buildEligibleMembershipsPayload(slot) {
  return {
    lineItems: [{
      id: randomUUID(),
      rootCatalogItemId: slot.serviceId,
      catalogReference: {
        catalogItemId: slot.serviceId,
        appId: cfg.wix.appId,
      },
      serviceProperties: {
        scheduledDate: toUtcIso(slot.startDate),
        numberOfParticipants: 1,
      },
    }],
  };
}

function buildActiveBookingsPayload(bookingUser) {
  return {
    query: {
      sort: [{ order: 'ASC', fieldName: 'startDate' }],
      filter: {
        endDate: { $gt: new Date().toISOString() },
        status: { $in: ['CONFIRMED', 'PENDING', 'WAITING_LIST'] },
        'contactDetails.contactId': bookingUser.profile.contactId,
        $or: [
          { appId: cfg.wix.appId },
          { appId: { $exists: false } },
        ],
      },
      paging: { offset: 0, limit: 50 },
    },
    withBookingAllowedActions: true,
    withBookingPolicySettings: true,
    withBookingConferencingDetails: true,
  };
}

function buildLocation() {
  return {
    id: cfg.wix.locationId,
    name: 'Dragos IBB Sosyal Tesisleri',
    formattedAddress: 'Orhantepe, Dragos IBB Sosyal Tesisleri, Kartal/İstanbul, Türkiye',
    locationType: 'OWNER_BUSINESS',
  };
}

function extractProfile(data, bookingUser) {
  const member = data?.member ?? data;
  const contact = member?.contact ?? member?.contactDetails ?? {};
  const profile = member?.profile ?? {};
  const name = parseName(
    profile.nickname
      ?? profile.name
      ?? member?.name
      ?? contact.name
      ?? contact.fullName
      ?? bookingUser.name
  );

  return {
    firstName: firstDefined(
      contact.firstName,
      contact.first_name,
      profile.firstName,
      profile.first_name,
      name.firstName
    ),
    lastName: firstDefined(
      contact.lastName,
      contact.last_name,
      profile.lastName,
      profile.last_name,
      name.lastName
    ),
    email: firstDefined(
      contact.email,
      contact.emails?.[0],
      contact.emails?.[0]?.email,
      profile.email,
      member?.loginEmail,
      bookingUser.account.email
    ),
    phone: normalizePhone(firstDefined(
      contact.phone,
      contact.phones?.[0],
      contact.phones?.[0]?.phone,
      contact.phones?.[0]?.formattedPhone,
      profile.phone
    )),
    contactId: firstDefined(
      member?.contactId,
      member?.contact?.id,
      contact.contactId,
      contact.id,
      member?.id
    ),
    memberId: member?.id,
  };
}

function extractEligibleMembership(data, bookingUser) {
  const candidates = [];
  collectMembershipCandidates(data, [], candidates);

  const preferredId = bookingUser.membership?.id;
  const preferredAppId = bookingUser.membership?.appId;
  const preferred = candidates.find(candidate => (
    (!preferredId || candidate.id === preferredId) &&
    (!preferredAppId || candidate.appId === preferredAppId)
  ));

  return preferred ?? candidates[0] ?? null;
}

function extractActiveBookings(data) {
  const candidates = [];
  collectBookingCandidates(data, candidates);

  return candidates.filter(booking => (
    ['CONFIRMED', 'PENDING', 'WAITING_LIST'].includes(booking.status)
  ));
}

function collectBookingCandidates(value, candidates) {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach(item => collectBookingCandidates(item, candidates));
    return;
  }

  const booking = value.booking ?? value;
  if (
    typeof booking === 'object' &&
    getBookingStartDate(booking) &&
    typeof booking.status === 'string'
  ) {
    candidates.push(booking);
  }

  Object.values(value).forEach(child => collectBookingCandidates(child, candidates));
}

function getBookingStartDate(booking) {
  return booking.startDate
    ?? booking.bookedEntity?.slot?.startDate
    ?? booking.slot?.startDate;
}

function collectMembershipCandidates(value, path, candidates) {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectMembershipCandidates(item, path.concat(String(index)), candidates);
    });
    return;
  }

  const id = value.id ?? value.membershipId;
  const appId = value.appId ?? value.applicationId;
  const pathText = path.join('.').toLowerCase();

  if (
    typeof id === 'string' &&
    typeof appId === 'string' &&
    pathText.includes('membership')
  ) {
    candidates.push({ id, appId });
  }

  Object.entries(value).forEach(([key, child]) => {
    collectMembershipCandidates(child, path.concat(key), candidates);
  });
}

function parseName(value) {
  if (!value || typeof value !== 'string') {
    return { firstName: undefined, lastName: undefined };
  }

  const parts = value.trim().split(/\s+/);
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ') || undefined,
  };
}

function normalizePhone(value) {
  const raw = typeof value === 'string'
    ? value
    : value?.phone ?? value?.formattedPhone ?? value?.number;

  if (!raw) return undefined;

  const trimmed = String(raw).trim();
  const digits = trimmed.replace(/\D/g, '');

  if (trimmed.startsWith('+')) {
    return `+${digits}`;
  }

  if (digits.startsWith('90')) {
    return `+${digits}`;
  }

  if (digits.startsWith('0') && digits.length === 11) {
    return `+90${digits.slice(1)}`;
  }

  if (digits.length === 10) {
    return `+90${digits}`;
  }

  return trimmed;
}

function toUtcIso(localDateTime) {
  const istanbulOffset = 3 * 60 * 60 * 1000;
  const utcMs = new Date(localDateTime).getTime() - istanbulOffset;
  return new Date(utcMs).toISOString();
}

function toIstanbulDateKey(dateTime) {
  if (!dateTime) return null;

  if (!dateTime.endsWith('Z') && !/[+-]\d\d:\d\d$/.test(dateTime)) {
    return dateTime.slice(0, 10);
  }

  const istanbulOffset = 3 * 60 * 60 * 1000;
  return new Date(new Date(dateTime).getTime() + istanbulOffset)
    .toISOString()
    .slice(0, 10);
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function normalizeSlot({ slot, service }) {
  return {
    startDate: slot.localStartDate,
    endDate: slot.localEndDate,
    eventId: slot.eventInfo?.eventId,
    serviceId: service.id,
    serviceName: service.name,
    remainingCapacity: slot.remainingCapacity,
    bookableCapacity: slot.bookableCapacity,
  };
}

function logUpcomingSlots(slots) {
  const upcoming = slots.filter(slot => (
    !slot.bookable && slot.bookingPolicyViolations?.tooEarlyToBook
  ));

  if (!upcoming.length) return;

  logger.info(`    Upcoming (too early):  ${upcoming.length}`);
  upcoming.slice(0, 3).forEach(slot => {
    const opens = slot.bookingPolicyViolations?.earliestBookingDate;
    logger.info(`      • ${slot.localStartDate}  (opens ${opens ?? '?'})`);
  });
}

function assertBookableSlot(slot) {
  if (!slot?.serviceId) {
    throw new Error(`Cannot create booking for ${slot?.startDate ?? 'unknown slot'}: missing serviceId`);
  }
  if (!slot.eventId) {
    throw new Error(`Cannot create booking for ${slot.startDate}: missing eventId`);
  }
}

function assertResolvedUser(bookingUser) {
  const requiredProfileFields = [
    'firstName',
    'lastName',
    'email',
    'phone',
    'contactId',
  ];
  const missing = requiredProfileFields.filter(field => !bookingUser.profile?.[field]);

  if (missing.length) {
    throw new Error(
      `Could not resolve required profile fields for ${formatUser(bookingUser)}: ${missing.join(', ')}`
    );
  }

  if (!/^\+[1-9]\d{7,14}$/.test(bookingUser.profile.phone)) {
    throw new Error(
      `Could not normalize phone for ${formatUser(bookingUser)}: "${bookingUser.profile.phone}". Use E.164 format like +905316217309.`
    );
  }
}

function getConfiguredServices() {
  if (Array.isArray(cfg.services) && cfg.services.length > 0) return cfg.services;
  if (cfg.service?.id) return [cfg.service];
  throw new Error('No services configured. Add at least one service to config.js');
}

function formatServiceName(service) {
  return service.name ?? service.id;
}

function formatUser(bookingUser) {
  return bookingUser.name ?? bookingUser.profile?.email ?? bookingUser.account.email;
}

function buildCommonConfig() {
  return encodeURIComponent(JSON.stringify({
    brand: 'wix',
    host: 'VIEWER',
    siteRevision: '185',
    renderingFlow: 'NONE',
    language: 'tr',
    locale: 'tr-tr',
  }));
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Converts a JS Date to a local datetime string for Istanbul (UTC+3).
 * Wix expects "2026-04-16T17:30:00" without an offset or trailing Z.
 */
function toLocalDateTime(date, endOfDay = false) {
  const istanbulOffset = 3 * 60 * 60 * 1000;
  const local = new Date(date.getTime() + istanbulOffset);
  const iso = local.toISOString().slice(0, 19);
  return endOfDay ? `${iso.slice(0, 10)}T23:59:59` : iso;
}

module.exports = {
  resolveBookingUser,
  getEligibleMembership,
  getActiveReservationDates,
  getAvailableSlots,
  createBooking,
  createCheckout,
  createOrder,
};
