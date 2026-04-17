function loadDotEnv(filePath) {
  if (process.env.CF_WORKER === "true") return;

  const fs = require("node:fs");
  const path = require("node:path");
  const envPath = filePath ?? path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return;

    const [, name, rawValue] = match;
    if (process.env[name] !== undefined) return;

    let value = rawValue.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    }

    process.env[name] = value;
  });
}

loadDotEnv();

const env = (name, fallback = "") => process.env[name] || fallback;

const SERVICES = {
  ANTRENMAN_KUREK: {
    id: "54d05900-2cf7-4354-a6c6-9474b4f90086",
    scheduleId: "caa57b9f-d7e2-4a27-a092-21583c6c9186",
    name: "Antrenman Kürek",
  },
  GENEL_KUREK: {
    id: "dddc4b0c-aaa4-43ff-8ffd-04c1d2cb2165",
    name: "Genel Kürek",
  },
  DENEME_DERSI: {
    id: "ce0c08a7-3c7c-46f7-9820-b0abf506067f",
    name: "Deneme Dersi",
  },
  TEMEL_KUREK_EGITIMI: {
    id: "a56b5bfe-49a4-4268-b88e-d57912c50f88",
    name: "Temel Kürek Eğitimi",
  },
  KANO_DRAGOS: {
    id: "015c059a-2e4e-45da-9f33-b761d39fd11e",
    name: "Kano Dragos",
  },
  SPOR_OKULU: {
    id: "a452f79e-f2a0-4aab-96e1-0c7a5d3ff014",
    name: "Spor Okulu",
  },
  OUTDOOR_TRAINING: {
    id: "9d581bf4-6024-413e-8ae2-e27e17298700",
    name: "Outdoor Training",
  },
};

module.exports = {
  users: [
    {
      name: "Hazal Düzen",
      account: {
        email: "hazalduzen@gmail.com",
        password: env("SUNSET_HAZAL_DUZEN_PASSWORD"),
      },
      session: {
        preferredDays: ["Tuesday", "Wednesday", "Friday", "Saturday", "Sunday"],
        preferredTimes: ["06:00", "07:00"],
      },
    },
    {
      name: "Bülent Coşan",
      account: {
        email: "buletncosan@mail.com",
        password: env("SUNSET_BULENT_COSAN_PASSWORD"),
      },
      session: {
        preferredDays: ["Tuesday", "Wednesday", "Friday", "Saturday", "Sunday"],
        preferredTimes: ["06:00", "07:00"],
      },
    },
    {
      name: "İsmail Altaş",
      account: {
        email: "ismailaltas@yandex.com",
        password: env("SUNSET_ISMAIL_ALTAS_PASSWORD"),
      },
      session: {
        preferredDays: ["Saturday", "Sunday"],
        preferredTimes: ["06:00", "07:00", "10:00"],
      },
    },
    {
      name: "Metehan Günel",
      account: {
        email: "metehangnel@gmail.com",
        password: env("SUNSET_METEHAN_GUNEL_PASSWORD"),
      },
      session: {
        preferredDays: ["Saturday", "Sunday"],
        preferredTimes: ["06:00", "07:00"],
      },
    },

    // Add another user by copying the object above and changing account,
    // profile, and membership values.
  ],

  wix: {
    baseUrl: "https://www.sunsetkurek.com",
    metaSiteId: "14f595d9-526b-457f-ae96-22ab613bd93d",
    instanceId: "927de40f-5841-4590-b788-ca076455874a",
    siteOwnerId: "8f63cbe2-2f20-469b-9b55-fc39f6095e9d",
    appId: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
    locationId: "dfa42da0-e919-4399-9e19-89cbdaabebfb",
    businessLocationId: "dfa42da0-e919-4399-9e19-89cbdaabebfb",
    resourceId: "76570209-101f-409b-af97-b445bdb63125",
    timezone: "Europe/Istanbul",
  },

  services: [SERVICES.ANTRENMAN_KUREK, SERVICES.GENEL_KUREK],

  // true = check login/profile/slots/membership, but do not create a booking.
  dryRun: env("DRY_RUN", "false") === "true",

  session: {
    lookAheadDays: 7,
    skipUsersOutsideCurrentHour:
      env("SKIP_USERS_OUTSIDE_CURRENT_HOUR", "false") === "true",
  },

  trigger: {
    type: env("TRIGGER_TYPE", "slot_available"),
    triggerDate: env("TRIGGER_DATE", "2026-05-01"),
    pollInterval: Number(env("POLL_INTERVAL_MS", 30 * 60 * 1000)),
  },

  retry: {
    maxAttempts: Number(env("RETRY_MAX_ATTEMPTS", 3)),
    delayMs: Number(env("RETRY_DELAY_MS", 8000)),
  },
};
