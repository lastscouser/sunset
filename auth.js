// Pure HTTP Wix login and token manager.

const cfg = require('./config');
const logger = require('./logger');

const BOOKINGS_APP_DEF_ID = '13d21c63-b5ec-5912-8397-c3a5ddb27a97';
const TOKEN_REFRESH_SAFETY_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 3.5 * 60 * 60 * 1000;

const BASE_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'tr-TR,tr;q=0.9',
  'content-type': 'application/json',
  'x-wix-brand': 'wix',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const sessions = new Map();

async function getToken(bookingUser = getLegacyUser()) {
  const session = getSession(bookingUser);

  if (hasValidToken(session)) {
    return session.memberToken;
  }

  logger.info(`🔑  Token missing/expired for ${formatUser(bookingUser)} — authenticating...`);
  await authenticate(bookingUser, session);
  return session.memberToken;
}

async function getMemberAuth(bookingUser = getLegacyUser()) {
  const token = await getToken(bookingUser);
  const session = getSession(bookingUser);

  return {
    token,
    memberId: session.memberId
      ?? bookingUser.profile?.memberId
      ?? bookingUser.profile?.contactId,
  };
}

async function authenticate(bookingUser, session) {
  session.cookieJar = {};

  const { anonToken, xsrfToken, sessionBind } = await loadSite(session);
  const sessionToken = await login(bookingUser, session, anonToken, xsrfToken);

  await createSessionCookie(session, sessionToken, anonToken, xsrfToken);
  await fetchAccessTokens(session, sessionBind);
}

async function loadSite(session) {
  logger.info('  [1/4] Loading site...');

  const res = await httpGet(session, '/');
  assertOk(res, 'Site load failed');

  const anonToken = extractAnonToken(res.body);
  const xsrfToken = session.cookieJar['XSRF-TOKEN'] ?? '';
  const sessionBind = session.cookieJar['server-session-bind'] ?? '';

  if (!anonToken) {
    throw new Error('Could not extract anonymous token from site');
  }

  logger.info(`  Anonymous token: ${anonToken.slice(0, 30)}...`);
  return { anonToken, xsrfToken, sessionBind };
}

async function login(bookingUser, session, anonToken, xsrfToken) {
  logger.info(`  [2/4] Logging in as ${bookingUser.account.email}...`);

  const res = await httpPost(
    session,
    '/_api/iam/authentication/v2/login',
    {
      loginId: { email: bookingUser.account.email },
      password: bookingUser.account.password,
      captchaTokens: [],
    },
    {
      authorization: anonToken,
      'x-xsrf-token': xsrfToken,
    }
  );

  assertOk(res, 'Login request failed');

  if (res.json?.state !== 'SUCCESS' || !res.json?.sessionToken) {
    throw new Error(`Login failed: ${JSON.stringify(res.json)}`);
  }

  logger.info(`  Login OK. MST2: ${res.json.sessionToken.slice(0, 40)}...`);
  return res.json.sessionToken;
}

async function createSessionCookie(session, sessionToken, anonToken, xsrfToken) {
  logger.info('  [3/4] Creating session cookie...');

  const res = await httpPost(
    session,
    '/_api/iam/cookie/v1/createSessionCookie',
    { sessionToken, protectedPages: false },
    {
      authorization: anonToken,
      'x-xsrf-token': xsrfToken,
      'x-wix-linguist': `tr|tr-tr|true|${cfg.wix.metaSiteId}`,
    }
  );

  assertOk(res, 'Session cookie request failed');

  logger.info('  Session cookie created.');
}

async function fetchAccessTokens(session, sessionBind) {
  logger.info('  [4/4] Fetching access tokens...');

  const res = await httpGet(session, '/_api/v1/access-tokens', {
    'client-binding': sessionBind,
  });

  assertOk(res, 'Access token request failed');

  const data = parseJsonResponse(res.body, 'access-tokens response is not JSON');
  const bookingsApp = data?.apps?.[BOOKINGS_APP_DEF_ID];
  const token = bookingsApp?.instance ?? bookingsApp?.accessToken;

  if (!token) {
    const keys = Object.keys(data?.apps ?? {}).join(', ');
    throw new Error(`Bookings app token not found in access-tokens response. Keys: ${keys}`);
  }

  const payload = parseJwt(token);

  session.memberToken = token;
  session.memberExpiry = getTokenExpiry(token, payload);
  session.memberId = payload?.uid ?? session.memberId;

  logger.info(`  ✅  Bookings token obtained. Expires: ${new Date(session.memberExpiry).toISOString()}`);
}

async function httpGet(session, path, extraHeaders = {}) {
  return httpRequest(session, path, { headers: extraHeaders });
}

async function httpPost(session, path, body, extraHeaders = {}) {
  return httpRequest(session, path, {
    method: 'POST',
    headers: extraHeaders,
    body,
  });
}

async function httpRequest(session, path, options = {}) {
  const res = await fetch(`${cfg.wix.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...BASE_HEADERS,
      ...options.headers,
      cookie: serializeCookies(session),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'follow',
  });

  parseCookies(session, res.headers);

  const body = await res.text();
  const json = parseJsonResponse(body);

  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    body,
    json,
  };
}

function hasValidToken(session) {
  return Boolean(
    session.memberToken &&
    session.memberExpiry &&
    Date.now() < session.memberExpiry - TOKEN_REFRESH_SAFETY_MS
  );
}

function getTokenExpiry(token, payload = parseJwt(token)) {
  if (payload?.expirationDate) {
    return new Date(payload.expirationDate).getTime();
  }

  return Date.now() + DEFAULT_TOKEN_TTL_MS;
}

function extractAnonToken(html) {
  const patterns = [
    /"instance"\s*:\s*"([^"]{50,})"/,
    /authorization["']?\s*:\s*["']([A-Za-z0-9_\-]{50,}\.[A-Za-z0-9_\-]{50,})["']/,
    /instance=([A-Za-z0-9_\-]{50,}\.[A-Za-z0-9_\-]{50,})/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1] && match[1].includes('.')) return match[1];
  }

  return null;
}

function parseCookies(session, headers) {
  const rawCookies = headers.getSetCookie?.() ?? [];

  for (const rawCookie of rawCookies) {
    const [pair] = rawCookie.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) {
      session.cookieJar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
}

function serializeCookies(session) {
  return Object.entries(session.cookieJar)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function parseJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function assertOk(res, message) {
  if (!res.ok) {
    throw new Error(`${message}: HTTP ${res.status} ${res.body}`);
  }
}

function parseJsonResponse(body, errorMessage) {
  try {
    return JSON.parse(body);
  } catch {
    if (errorMessage) throw new Error(errorMessage);
    return null;
  }
}

function getSession(bookingUser) {
  const key = getUserKey(bookingUser);
  if (!sessions.has(key)) {
    sessions.set(key, {
      memberToken: null,
      memberExpiry: null,
      memberId: bookingUser.profile?.memberId ?? bookingUser.profile?.contactId,
      cookieJar: {},
    });
  }
  return sessions.get(key);
}

function getUserKey(bookingUser) {
  return bookingUser.account.email;
}

function formatUser(bookingUser) {
  return bookingUser.name ?? bookingUser.profile?.email ?? bookingUser.account.email;
}

function getLegacyUser() {
  return {
    name: cfg.user?.email ?? cfg.account?.email,
    account: cfg.account,
    profile: cfg.user,
    membership: cfg.membership,
  };
}

module.exports = { getToken, getMemberAuth };
