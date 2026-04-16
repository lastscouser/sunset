// Sunset Kurek Reservation Bot entrypoint.

const cfg = require('./config');
const logger = require('./logger');
const {
  resolveBookingUser,
  getEligibleMembership,
  getActiveReservationDates,
  getAvailableSlots,
  createBooking,
  createCheckout,
  createOrder,
} = require('./api');
const { pickSlot } = require('./slotPicker');

const TRIGGER_TYPES = {
  MANUAL: 'manual',
  DATE_REACHED: 'date_reached',
  SLOT_AVAILABLE: 'slot_available',
};

const TERMINAL_REASONS = new Set(['no_slots', 'no_membership', 'skipped_current_hour']);
const completedUserKeys = new Set();
let dryRun = false;

if (require.main === module) {
  main().catch(err => {
    logger.error(`Fatal error: ${err.stack ?? err.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  logBanner();
  validateConfig();

  const args = process.argv.slice(2);
  const runOnce = args.includes('--once');
  dryRun = args.includes('--dry-run') || cfg.dryRun === true;
  const triggerType = runOnce ? TRIGGER_TYPES.MANUAL : cfg.trigger.type;

  logger.info(`Trigger: ${runOnce ? 'manual (--once)' : triggerType}`);
  if (dryRun) {
    logger.warn('DRY RUN enabled — booking, checkout, and order creation will be skipped.');
  }

  switch (triggerType) {
    case TRIGGER_TYPES.MANUAL:
      await runWithRetry();
      return;

    case TRIGGER_TYPES.DATE_REACHED:
      await waitForDate(cfg.trigger.triggerDate);
      await runWithRetry();
      return;

    case TRIGGER_TYPES.SLOT_AVAILABLE:
      await pollUntilBooked();
      return;

    default:
      throw new Error(`Unknown trigger: "${triggerType}". Check config.js`);
  }
}

async function runCloudflareScheduled(options = {}) {
  completedUserKeys.clear();
  logBanner();
  validateConfig();

  dryRun = options.dryRun ?? cfg.dryRun === true;

  logger.info('Trigger: cloudflare scheduled');
  if (dryRun) {
    logger.warn('DRY RUN enabled — booking, checkout, and order creation will be skipped.');
  }

  return runWithRetry();
}

async function pollUntilBooked() {
  const mins = Math.round(cfg.trigger.pollInterval / 60000);
  logger.info(`⏱️  Polling every ${mins} min until a slot is booked...`);

  while (true) {
    logger.info('─── Poll cycle ──────────────────────────');

    const result = await runWithRetry();
    if (result.dryRun) {
      logger.info('🧪  DRY RUN complete. Stopping.');
      return;
    }

    if (result.success) {
      logger.info('🏁  Done — all configured users booked. Stopping.');
      return;
    }

    if (result.reason === 'no_membership') {
      logger.error('Stopping because at least one user has no eligible membership.');
      return;
    }

    logger.info(`⏳  Waiting ${mins} min before next check...`);
    await sleep(cfg.trigger.pollInterval);
  }
}

async function waitForDate(dateStr) {
  const target = new Date(dateStr);

  if (Number.isNaN(target.getTime())) {
    throw new Error(`Invalid triggerDate: "${dateStr}"`);
  }

  logger.info(`📅  Waiting until ${dateStr}...`);

  while (Date.now() < target.getTime()) {
    const hoursRemaining = Math.round((target.getTime() - Date.now()) / 3_600_000);
    logger.info(`  ${hoursRemaining}h remaining. Sleeping 30 min.`);
    await sleep(30 * 60 * 1000);
  }

  logger.info('📅  Target date reached!');
}

async function runWithRetry() {
  const { maxAttempts, delayMs } = cfg.retry;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info(`🔄  Attempt ${attempt}/${maxAttempts}`);

    const result = await tryBookOnce(attempt);
    if (result.success || TERMINAL_REASONS.has(result.reason)) {
      return result;
    }

    if (attempt < maxAttempts) {
      logger.info(`  Retrying in ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }

  logger.error('All attempts exhausted.');
  return { success: false, reason: 'all_failed' };
}

async function tryBookOnce(attempt) {
  try {
    return await book();
  } catch (err) {
    logger.error(`Attempt ${attempt} threw: ${err.message}`);
    return { success: false, reason: 'exception', error: err };
  }
}

async function book() {
  const users = getPendingUsers();

  if (!users.length) {
    logger.info('All configured users are already booked in this run.');
    return { success: true, reason: 'all_users_booked' };
  }

  let bookedCount = 0;
  let noSlotCount = 0;
  let noMembershipCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const bookingUser of users) {
    if (shouldSkipUserForCurrentHour(bookingUser)) {
      skippedCount++;
      continue;
    }

    const result = await tryBookUser(bookingUser);

    if (result.success) {
      completedUserKeys.add(getUserKey(bookingUser));
      bookedCount++;
    } else if (result.reason === 'no_slots') {
      noSlotCount++;
    } else if (result.reason === 'no_membership') {
      noMembershipCount++;
    } else {
      errorCount++;
    }
  }

  const pendingUsers = getPendingUsers();

  if (skippedCount > 0) {
    logger.info(`${skippedCount} user(s) skipped because their preferredTimes do not match the current hour.`);
  }

  if (!pendingUsers.length) {
    return { success: true, bookedCount, dryRun };
  }

  if (noMembershipCount > 0) {
    logger.error(`${noMembershipCount} user(s) have no eligible membership. Not retrying.`);
    return { success: false, reason: 'no_membership', bookedCount };
  }

  if (bookedCount > 0 && noSlotCount > 0) {
    logger.info(`${bookedCount} user(s) booked. ${pendingUsers.length} user(s) still waiting for a matching slot.`);
    return { success: false, reason: 'partial_no_slots', bookedCount };
  }

  if (noSlotCount > 0 && errorCount === 0) {
    return { success: false, reason: 'no_slots' };
  }

  if (skippedCount > 0 && errorCount === 0) {
    return { success: false, reason: 'skipped_current_hour', bookedCount, skippedCount };
  }

  return { success: false, reason: 'user_failed' };
}

async function tryBookUser(bookingUser) {
  try {
    return await bookForUser(bookingUser);
  } catch (err) {
    if (err.code === 'NO_ELIGIBLE_MEMBERSHIP') {
      logger.error(`User ${formatUser(bookingUser)} has no eligible membership: ${err.message}`);
      return { success: false, reason: 'no_membership', error: err };
    }

    logger.error(`User ${formatUser(bookingUser)} failed: ${err.message}`);
    return { success: false, reason: 'exception', error: err };
  }
}

async function bookForUser(bookingUser) {
  logger.info(`👤  Booking user: ${formatUser(bookingUser)}`);

  const resolvedUser = await resolveBookingUser(bookingUser);
  const slots = await getAvailableSlots(resolvedUser);
  const activeReservationDates = await getActiveReservationDates(resolvedUser);
  const slotsWithoutReservedDays = filterReservedDays(slots, activeReservationDates);
  const slot = pickSlot(slotsWithoutReservedDays, getUserSession(resolvedUser));

  if (!slot) {
    logger.info(`⏳  No matching slots right now for ${formatUser(resolvedUser)}.`);
    return { success: false, reason: 'no_slots' };
  }

  logger.info(`✅  Selected slot: ${formatSlot(slot)}`);

  if (dryRun) {
    const membership = await getEligibleMembership(resolvedUser, slot);
    logger.info(`🧪  DRY RUN: eligible membership resolved: ${membership.id}`);
    logger.info(`🧪  DRY RUN: would book ${formatSlot(slot)} for ${formatUser(resolvedUser)}.`);
    return {
      success: true,
      dryRun: true,
      slot,
      membership,
    };
  }

  const bookingId = await createBooking(slot, resolvedUser);
  const checkoutId = await createCheckout(bookingId, resolvedUser, slot);
  const orderId = await createOrder(checkoutId, resolvedUser);

  logConfirmation({ user: resolvedUser, slot, bookingId, orderId });

  return { success: true, bookingId, checkoutId, orderId };
}

function validateConfig() {
  const users = getConfiguredUsers();
  const requiredValues = [
    ['wix.baseUrl', cfg.wix.baseUrl],
    ['wix.instanceId', cfg.wix.instanceId],
  ];

  const missing = requiredValues
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(`Missing required config values: ${missing.join(', ')}`);
  }

  validateUsers(users);

  if (!Array.isArray(cfg.services) || cfg.services.length === 0) {
    throw new Error('At least one service must be configured in config.js');
  }

  const servicesWithoutIds = cfg.services.filter(service => !service?.id);
  if (servicesWithoutIds.length) {
    throw new Error('Every configured service must have an id');
  }

  if (!Number.isFinite(cfg.session.lookAheadDays) || cfg.session.lookAheadDays < 1) {
    throw new Error('session.lookAheadDays must be a positive number');
  }

  if (!Number.isFinite(cfg.retry.maxAttempts) || cfg.retry.maxAttempts < 1) {
    throw new Error('retry.maxAttempts must be a positive number');
  }

  if (!Number.isFinite(cfg.retry.delayMs) || cfg.retry.delayMs < 0) {
    throw new Error('retry.delayMs must be a non-negative number');
  }

  if (!Number.isFinite(cfg.trigger.pollInterval) || cfg.trigger.pollInterval < 1000) {
    throw new Error('trigger.pollInterval must be at least 1000ms');
  }
}

function validateUsers(users) {
  if (!users.length) {
    throw new Error('At least one user must be configured in config.js');
  }

  const missing = [];

  users.forEach((user, index) => {
    const prefix = `users[${index}]`;
    [
      ['account.email', user.account?.email],
      ['account.password', user.account?.password],
    ].forEach(([field, value]) => {
      if (!value) missing.push(`${prefix}.${field}`);
    });
  });

  if (missing.length) {
    throw new Error(`Missing required user config values: ${missing.join(', ')}`);
  }

  const invalidSessionUsers = users
    .map((user, index) => ({ user, index }))
    .filter(({ user }) => (
      user.session &&
      (
        !Array.isArray(user.session.preferredDays ?? []) ||
        !Array.isArray(user.session.preferredTimes ?? [])
      )
    ));

  if (invalidSessionUsers.length) {
    throw new Error(
      `User session preferredDays/preferredTimes must be arrays: ${invalidSessionUsers.map(({ index }) => `users[${index}]`).join(', ')}`
    );
  }
}

function logBanner() {
  logger.info('═══════════════════════════════════════════');
  logger.info('   Sunset Kürek  –  Reservation Bot  🚣   ');
  logger.info('═══════════════════════════════════════════');
}

function logConfirmation({ user, slot, bookingId, orderId }) {
  logger.info('');
  logger.info('╔══════════════════════════════════════════╗');
  logger.info('║  🎉  RESERVATION CONFIRMED!              ║');
  logger.info(`║  User:      ${formatUser(user).slice(0, 29).padEnd(29)}║`);
  logger.info(`║  Slot:      ${slot.startDate.slice(0, 16).padEnd(29)}║`);
  logger.info(`║  Service:   ${(slot.serviceName ?? slot.serviceId).slice(0, 29).padEnd(29)}║`);
  logger.info(`║  Booking:   ${bookingId.slice(0, 29).padEnd(29)}║`);
  logger.info(`║  Order:     ${orderId.slice(0, 29).padEnd(29)}║`);
  logger.info('╚══════════════════════════════════════════╝');
}

function formatSlot(slot) {
  return `${slot.startDate} → ${slot.endDate} (${slot.serviceName ?? slot.serviceId})`;
}

function filterReservedDays(slots, activeReservationDates) {
  if (!activeReservationDates.size) {
    return slots;
  }

  const filtered = slots.filter(slot => !activeReservationDates.has(slot.startDate.slice(0, 10)));
  const skipped = slots.length - filtered.length;

  if (skipped > 0) {
    logger.info(`  Skipped ${skipped} slot(s) on days with existing reservations.`);
  }

  return filtered;
}

function getUserSession(user) {
  return {
    preferredDays: user.session?.preferredDays ?? cfg.session.preferredDays ?? [],
    preferredTimes: user.session?.preferredTimes ?? cfg.session.preferredTimes ?? [],
  };
}

function shouldSkipUserForCurrentHour(user, now = new Date()) {
  if (!cfg.session.skipUsersOutsideCurrentHour) {
    return false;
  }

  const preferredTimes = getUserSession(user).preferredTimes;
  if (!Array.isArray(preferredTimes) || preferredTimes.length === 0) {
    return false;
  }

  const currentHour = getCurrentHourForTimezone(now, cfg.wix.timezone);
  const matchesCurrentHour = preferredTimes.some(time => (
    typeof time === 'string' && time.slice(0, 2) === currentHour
  ));

  if (!matchesCurrentHour) {
    logger.info(
      `⏭️  Skipping ${formatUser(user)}: current hour ${currentHour}:00 does not match preferredTimes ${preferredTimes.join(', ')}.`
    );
  }

  return !matchesCurrentHour;
}

function getCurrentHourForTimezone(date, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'UTC',
    hour: '2-digit',
    hour12: false,
  }).format(date);
}

function getPendingUsers() {
  return getConfiguredUsers().filter(user => !completedUserKeys.has(getUserKey(user)));
}

function getConfiguredUsers() {
  if (Array.isArray(cfg.users) && cfg.users.length > 0) {
    return cfg.users;
  }

  if (cfg.account && cfg.user && cfg.membership) {
    return [{
      name: cfg.user.email ?? cfg.account.email,
      account: cfg.account,
      profile: cfg.user,
      membership: cfg.membership,
    }];
  }

  return [];
}

function getUserKey(user) {
  return user.profile?.contactId ?? user.account.email;
}

function formatUser(user) {
  return user.name ?? user.profile?.email ?? user.account.email;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  runCloudflareScheduled,
  runWithRetry,
  book,
  validateConfig,
  shouldSkipUserForCurrentHour,
  getCurrentHourForTimezone,
};
