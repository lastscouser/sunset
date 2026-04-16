# Sunset Kurek Reservation Bot

Pure HTTP Node.js bot for booking Sunset Kurek sessions through Wix Bookings.

## Requirements

- Node.js 18+
- No npm install needed

## Run

Create `.env` from `.env.example` and fill in the passwords:

```bash
cp .env.example .env
```

```bash
node index.js
node index.js --once
node index.js --once --dry-run
```

`node index.js --once` runs the booking flow immediately. It can create real reservations.

`--dry-run` logs in, fetches profile data, checks active reservations, checks slots, and resolves eligible membership. It does not create a booking, checkout, or order.

You can also enable dry run from config or environment:

```bash
DRY_RUN=true node index.js --once
```

Environment variables exported in your shell take priority over values from `.env`.

## Users

Users are configured in `config.js` under `users`.

Each user needs:

- `account.email`: Wix login email
- `account.password`: Wix login password, read from environment variables

The bot fetches profile/contact details from Wix Members after login:

```text
GET /_api/members/v1/members/{memberId}?id={memberId}&fieldsets=FULL
```

Add `profile` only when you need to override a fetched value.

The bot also fetches eligible memberships after a slot is selected:

```text
POST /memberships-spi-host/v1/list-eligible-memberships
```

Add `membership` only when you need to force a specific membership instead of using the first eligible one returned by Wix.

Before picking a slot, the bot also checks active reservations:

```text
POST /_api/bookings-reader/v2/extended-bookings/query
```

If a user already has a `CONFIRMED`, `PENDING`, or `WAITING_LIST` reservation on a day, the bot skips all available slots on that same day for that user.

Example:

```js
users: [
  {
    name: 'Hazal Duzen',
    account: {
      email: 'hazal@example.com',
      password: env('SUNSET_HAZAL_DUZEN_PASSWORD'),
    },
    session: {
      preferredDays: ['Tuesday', 'Thursday', 'Saturday'],
      preferredTimes: ['06:00', '07:00'],
    },
  },
  {
    name: 'Second User',
    account: {
      email: 'second@example.com',
      password: env('SUNSET_SECOND_USER_PASSWORD'),
    },
    profile: {
      phone: '+905...', // optional override if Wix Members has stale data
    },
    membership: {
      id: '...',
      appId: '...', // optional override to force a specific membership
    },
    session: {
      preferredDays: ['Wednesday', 'Friday', 'Sunday'],
      preferredTimes: ['08:00', '09:00', '10:00'],
    },
  },
]
```

The bot processes users one by one. Each user has a separate login session, token cache, resolved profile, and membership. If one user is booked successfully, that user is skipped for the rest of the current process so retries or polling do not double-book them.

## Services

Configured services are in `config.js` under `services`.

Current defaults:

- `Antrenman Kurek`
- `Genel Kurek`

The bot checks each configured service and picks the earliest slot that matches that user's configured days and times.

## Slot Preferences

Configured per user in `config.js`:

```js
users: [{
  name: 'Hazal Duzen',
  session: {
    preferredDays: ['Tuesday', 'Thursday', 'Saturday'],
    preferredTimes: ['06:00', '07:00'],
  },
}]
```

`preferredDays` and `preferredTimes` are strict filters. A slot must match both lists unless a list is empty.

`session.lookAheadDays` remains global and controls how far ahead the bot queries Wix.

Examples:

- Empty `preferredDays` means any day.
- Empty `preferredTimes` means any time.
- With both lists populated, only exact day and time matches are booked.

## Trigger Modes

Configured in `config.js`:

```js
trigger: {
  type: 'slot_available',
  triggerDate: '2026-05-01',
  pollInterval: 5 * 60 * 1000,
}
```

Supported trigger types:

- `manual`: run once
- `date_reached`: wait until `triggerDate`, then run once
- `slot_available`: poll until all configured users are booked

## Auth Flow

Current flow:

```text
1. GET  /                                                -> cookies + anonymous token
2. POST /_api/iam/authentication/v2/login                -> MST2 sessionToken
3. POST /_api/iam/cookie/v1/createSessionCookie          -> member session cookie
4. GET  /_api/v1/access-tokens                           -> bookings app token
5. POST /_api/service-availability/v2/time-slots/event   -> slots
6. POST /_api/bookings-service/v2/bulk/bookings/create   -> bookingId
7. POST /ecom/v1/checkouts                               -> checkoutId
8. POST /memberships-spi-host/v1/list-eligible-memberships -> membership
9. POST /ecom/v1/checkouts                               -> checkoutId
10. POST /ecom/v1/checkouts/{id}/create-order            -> orderId
```

## Output

- Console logs
- `bot.log`
