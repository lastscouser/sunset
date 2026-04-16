// Strict slot selection based on configured days and times.

const logger = require('./logger');

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function pickSlot(slots, sessionConfig = {}) {
  if (!Array.isArray(slots) || slots.length === 0) {
    return null;
  }

  const preferences = buildPreferences(sessionConfig);
  logger.info(
    `  Preferences: days=${formatPreferenceLog(preferences.days)} times=${formatPreferenceLog(preferences.times)}`
  );

  const matchingSlots = slots
    .map(slot => describeSlot(slot, preferences))
    .filter(candidate => candidate.matches)
    .sort(compareCandidatesByStartDate);

  if (!matchingSlots.length) {
    logger.info('  No slots matched the configured preferred days/times.');
    return null;
  }

  const best = matchingSlots[0];
  logger.info(
    `  🎯  Picked: ${best.dayName} ${best.timeStr} ${best.serviceName} (cap ${best.slot.remainingCapacity})`
  );

  return best.slot;
}

function buildPreferences(sessionConfig) {
  return {
    days: new Set(sessionConfig.preferredDays ?? []),
    times: new Set(sessionConfig.preferredTimes ?? []),
  };
}

function formatPreferenceLog(preferences) {
  return preferences.size ? Array.from(preferences).join(',') : 'any';
}

function describeSlot(slot, preferences) {
  const date = new Date(slot.startDate);
  const dayName = DAY_NAMES[date.getDay()];
  const timeStr = slot.startDate.slice(11, 16);
  const serviceName = slot.serviceName ?? slot.serviceId ?? 'unknown service';
  const matches = matchesPreferences(dayName, timeStr, preferences);

  logger.info(
    `    ${dayName} ${timeStr}  ${serviceName}  cap:${slot.remainingCapacity}  match:${matches ? 'yes' : 'no'}`
  );

  return { slot, dayName, timeStr, serviceName, matches };
}

function matchesPreferences(dayName, timeStr, preferences) {
  const dayMatches = preferences.days.size === 0 || preferences.days.has(dayName);
  const timeMatches = preferences.times.size === 0 || preferences.times.has(timeStr);
  return dayMatches && timeMatches;
}

function compareCandidatesByStartDate(a, b) {
  return new Date(a.slot.startDate) - new Date(b.slot.startDate);
}

module.exports = { pickSlot };
