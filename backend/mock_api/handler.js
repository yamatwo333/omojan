const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const MOCK_DIR = path.join(ROOT_DIR, "mock_api");

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(MOCK_DIR, fileName), "utf8"));
}

function nowIso() {
  return new Date().toISOString();
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
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

function notImplemented(routeLabel) {
  return fail(501, "NOT_IMPLEMENTED", `${routeLabel} はまだ mock API 未実装です。`);
}

function parseBody(event) {
  if (!event.body) {
    return {};
  }
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((headerName) => headerName.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : "";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildPatchedRoom(baseRoom, patch) {
  return {
    ...clone(baseRoom),
    ...patch
  };
}

function getRoomScenario(scenarioName = "lobby") {
  const roomScenarios = readJson("room_scenarios.json");
  return roomScenarios.scenarios[scenarioName] || null;
}

function parseRoute(method, pathname) {
  const routes = [
    { method: "GET", pattern: /^\/v1\/champions\/recent$/, route: "getChampionsRecent" },
    { method: "GET", pattern: /^\/v1\/admin\/decks\/([^/]+)$/, route: "getDeck" },
    { method: "POST", pattern: /^\/v1\/rooms$/, route: "createRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/join$/, route: "joinRoom" },
    { method: "GET", pattern: /^\/v1\/rooms\/([^/]+)$/, route: "getRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/reconnect$/, route: "reconnectRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/start-player$/, route: "startPlayer" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/start$/, route: "startGame" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/submit$/, route: "submitWord" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/vote$/, route: "submitVote" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/revote$/, route: "submitRevote" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/host-decision$/, route: "submitHostDecision" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/rounds\/(\d+)\/proceed$/, route: "proceedRound" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/final-vote$/, route: "submitFinalVote" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/final-revote$/, route: "submitFinalRevote" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/final-host-decision$/, route: "submitFinalHostDecision" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/restart$/, route: "restartGame" }
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

function handleGetChampionsRecent(event) {
  const payload = readJson("champions_recent.json");
  const requestedLimit = Number(event.queryStringParameters?.limit || "5");
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5;
  const items = payload.data.items.slice(0, limit);
  return ok({ items });
}

function handleGetDeck(event, deckId) {
  if (deckId !== "default") {
    return fail(404, "DECK_NOT_FOUND", "指定されたデッキは存在しません。");
  }
  const payload = readJson("deck_default.json");
  return ok(payload.data);
}

function handleCreateRoom(event) {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }
  const displayName = String(body.displayName || "").trim() || "ホスト";
  const playerCount = [2, 3, 4].includes(body.playerCount) ? body.playerCount : 4;
  const scenario = getRoomScenario("lobby");
  const room = buildPatchedRoom(scenario.data.room, {
    playerCount,
    hostPlayerId: "player_host",
    me: {
      playerId: "player_host",
      displayName,
      isHost: true,
      reconnectTokenIssued: true
    },
    game: {
      ...clone(scenario.data.room.game),
      players: clone(scenario.data.room.game.players).map((player) =>
        player.playerId === "player_host"
          ? {
              ...player,
              displayName,
              isHost: true
            }
          : player
      )
    }
  });

  return ok({
    playerToken: "pt_mock_host",
    room
  });
}

function handleJoinRoom(event) {
  const body = parseBody(event);
  if (!body) {
    return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
  }
  const inviteCode = String(body.inviteCode || "").trim();
  if (!inviteCode) {
    return fail(400, "INVITE_NOT_FOUND", "招待コードが必要です。");
  }
  const displayName = String(body.displayName || "").trim() || "参加者";
  const scenario = getRoomScenario("lobby");
  const room = buildPatchedRoom(scenario.data.room, {
    inviteCode,
    me: {
      playerId: "player_you",
      displayName,
      isHost: false,
      reconnectTokenIssued: true
    },
    game: {
      ...clone(scenario.data.room.game),
      players: clone(scenario.data.room.game.players).map((player) =>
        player.playerId === "player_you"
          ? {
              ...player,
              displayName,
              isHost: false
            }
          : player
      )
    }
  });

  return ok({
    playerToken: "pt_mock_you",
    room
  });
}

function handleGetRoom(event, roomId) {
  const scenarioName = event.queryStringParameters?.scenario || "lobby";
  const scenario = getRoomScenario(scenarioName);
  if (!scenario) {
    return fail(404, "ROOM_NOT_FOUND", "指定されたシナリオが存在しません。");
  }
  const room = clone(scenario.data.room);
  if (roomId && room.roomId !== roomId) {
    room.roomId = roomId;
  }
  return ok({ room });
}

function handleReconnect(event, roomId) {
  const playerToken = getHeader(event, "X-Omojan-Player-Token");
  if (!playerToken) {
    return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
  }
  return handleGetRoom(event, roomId);
}

async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const pathname = event.rawPath || event.path || "/";
  const matched = parseRoute(method, pathname);

  if (!matched) {
    return fail(404, "ROUTE_NOT_FOUND", "指定された API は存在しません。");
  }

  switch (matched.route) {
    case "getChampionsRecent":
      return handleGetChampionsRecent(event);
    case "getDeck":
      return handleGetDeck(event, matched.params[0]);
    case "createRoom":
      return handleCreateRoom(event);
    case "joinRoom":
      return handleJoinRoom(event);
    case "getRoom":
      return handleGetRoom(event, matched.params[0]);
    case "reconnectRoom":
      return handleReconnect(event, matched.params[0]);
    case "startPlayer":
      return notImplemented("start-player");
    case "startGame":
      return notImplemented("start");
    case "submitWord":
      return notImplemented("submit");
    case "submitVote":
      return notImplemented("vote");
    case "submitRevote":
      return notImplemented("revote");
    case "submitHostDecision":
      return notImplemented("host-decision");
    case "proceedRound":
      return notImplemented("round proceed");
    case "submitFinalVote":
      return notImplemented("final-vote");
    case "submitFinalRevote":
      return notImplemented("final-revote");
    case "submitFinalHostDecision":
      return notImplemented("final-host-decision");
    case "restartGame":
      return notImplemented("restart");
    default:
      return fail(404, "ROUTE_NOT_FOUND", "指定された API は存在しません。");
  }
}

module.exports = {
  handler,
  parseRoute,
  handleGetRoom,
  handleCreateRoom,
  handleJoinRoom
};
