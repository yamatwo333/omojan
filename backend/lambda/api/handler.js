const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const MOCK_DIR = path.join(ROOT_DIR, "mock_api");

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(MOCK_DIR, fileName), "utf8"));
}

function nowIso() {
  return new Date().toISOString();
}

function buildHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-omojan-player-token"
  };
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: buildHeaders(),
    body: JSON.stringify(payload, null, 2)
  };
}

function ok(data) {
  return json(200, {
    ok: true,
    data,
    serverTime: nowIso()
  });
}

function fail(statusCode, code, message, retryable = false) {
  return json(statusCode, {
    ok: false,
    error: {
      code,
      message,
      retryable
    },
    serverTime: nowIso()
  });
}

function parseRoute(method, pathname) {
  const routes = [
    { method: "GET", pattern: /^\/v1\/health$/, route: "health" },
    { method: "GET", pattern: /^\/v1\/champions\/recent$/, route: "getChampionsRecent" },
    { method: "GET", pattern: /^\/v1\/admin\/decks\/([^/]+)$/, route: "getDeck" },
    { method: "POST", pattern: /^\/v1\/rooms$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/join$/, route: "notImplemented" },
    { method: "GET", pattern: /^\/v1\/rooms\/([^/]+)$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/reconnect$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/start-player$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/start$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/submit$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/vote$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/revote$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/host-decision$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/proceed$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/final-vote$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/final-revote$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/final-host-decision$/, route: "notImplemented" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/restart$/, route: "notImplemented" }
  ];

  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const match = pathname.match(route.pattern);
    if (match) {
      return { route: route.route, params: match.slice(1) };
    }
  }
  return null;
}

function handleHealth() {
  return ok({
    service: "omojan-api",
    mode: "lambda-scaffold",
    stage: process.env.APP_STAGE || "dev",
    tableName: process.env.APP_TABLE_NAME || "",
    region: process.env.AWS_REGION || ""
  });
}

function handleGetChampionsRecent(event) {
  const payload = readJson("champions_recent.json");
  const requestedLimit = Number(event.queryStringParameters?.limit || "5");
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5;
  return ok({
    items: payload.data.items.slice(0, limit)
  });
}

function handleGetDeck(deckId) {
  if (deckId !== "default") {
    return fail(404, "DECK_NOT_FOUND", "指定されたデッキは存在しません。");
  }
  const payload = readJson("deck_default.json");
  return ok(payload.data);
}

function handleNotImplemented(pathname) {
  return fail(
    501,
    "NOT_IMPLEMENTED",
    `${pathname} は Lambda 雛形のみ作成済みです。次に DynamoDB 実装を接続します。`
  );
}

async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const pathname = event.rawPath || event.path || "/";

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: buildHeaders(),
      body: ""
    };
  }

  const matched = parseRoute(method, pathname);
  if (!matched) {
    return fail(404, "ROUTE_NOT_FOUND", "指定された API は存在しません。");
  }

  switch (matched.route) {
    case "health":
      return handleHealth();
    case "getChampionsRecent":
      return handleGetChampionsRecent(event);
    case "getDeck":
      return handleGetDeck(matched.params[0]);
    case "notImplemented":
      return handleNotImplemented(pathname);
    default:
      return fail(404, "ROUTE_NOT_FOUND", "指定された API は存在しません。");
  }
}

module.exports = {
  handler,
  parseRoute
};
