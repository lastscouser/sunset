function applyWorkerEnv(env) {
  globalThis.process ??= { env: {} };
  process.env ??= {};
  process.env.CF_WORKER = "true";

  Object.entries(env).forEach(([key, value]) => {
    if (typeof value === "string") {
      process.env[key] = value;
    }
  });
}

function isTrue(value) {
  return value === true || value === "true";
}

async function runBot(env, options = {}) {
  applyWorkerEnv(env);

  const botModule = await import("./index.js");
  const bot = botModule.default ?? botModule;

  return bot.runCloudflareScheduled({
    dryRun: options.dryRun ?? isTrue(env.DRY_RUN),
  });
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function isAuthorized(request, env) {
  if (!env.MANUAL_RUN_TOKEN) return false;

  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${env.MANUAL_RUN_TOKEN}`;
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runBot(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/run") {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      const result = await runBot(env, {
        dryRun: url.searchParams.get("dry_run") === "true",
      });

      return jsonResponse({ ok: true, result });
    }

    return jsonResponse({
      ok: true,
      service: "sunset-reservation-bot",
      message: "Cron trigger is configured. Use POST /run with MANUAL_RUN_TOKEN for manual runs.",
    });
  },
};
