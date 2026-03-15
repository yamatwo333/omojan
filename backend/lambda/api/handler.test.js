const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler, createMemoryRoomRepository } = require("./handler");

function createEvent(method, path, options = {}) {
  return {
    rawPath: path,
    queryStringParameters: options.query || {},
    headers: options.headers || {},
    body: options.body ? JSON.stringify(options.body) : "",
    requestContext: {
      http: {
        method
      }
    }
  };
}

async function parseResponse(response) {
  return JSON.parse(response.body || "{}");
}

function createTestHandler() {
  return createHandler({
    roomRepository: createMemoryRoomRepository()
  });
}

test("GET /v1/health returns lambda scaffold metadata", async () => {
  process.env.APP_STAGE = "dev";
  process.env.APP_TABLE_NAME = "OmojanApp";

  const handler = createTestHandler();
  const response = await handler(createEvent("GET", "/v1/health"));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.mode, "lambda-scaffold");
  assert.equal(body.data.tableName, "OmojanApp");
  assert.deepEqual(body.data.implementedRoutes, [
    "rooms:create",
    "rooms:join",
    "rooms:get",
    "rooms:reconnect",
    "rooms:start-player"
  ]);
});

test("GET /v1/champions/recent returns recent items", async () => {
  const handler = createTestHandler();
  const response = await handler(createEvent("GET", "/v1/champions/recent", { query: { limit: "2" } }));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.items.length, 2);
});

test("POST /v1/rooms creates a lobby room with player token", async () => {
  const handler = createTestHandler();
  const response = await handler(createEvent("POST", "/v1/rooms", { body: { displayName: "やまだ", playerCount: 3 } }));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.match(body.data.playerToken, /^pt_/);
  assert.equal(body.data.room.status, "lobby");
  assert.equal(body.data.room.playerCount, 3);
  assert.equal(body.data.room.game.phase, "lobby");
  assert.equal(body.data.room.game.players.length, 1);
  assert.equal(body.data.room.me.displayName, "やまだ");
});

test("POST /v1/rooms/join adds a new player and GET /v1/rooms/:roomId requires that token", async () => {
  const handler = createTestHandler();
  const createResponse = await handler(createEvent("POST", "/v1/rooms", { body: { displayName: "ホスト", playerCount: 2 } }));
  const createBody = await parseResponse(createResponse);

  const joinResponse = await handler(
    createEvent("POST", "/v1/rooms/join", {
      body: {
        inviteCode: createBody.data.room.inviteCode,
        displayName: "ゲスト"
      }
    })
  );
  const joinBody = await parseResponse(joinResponse);

  assert.equal(joinResponse.statusCode, 200);
  assert.equal(joinBody.ok, true);
  assert.equal(joinBody.data.room.game.players.length, 2);
  assert.equal(joinBody.data.room.me.displayName, "ゲスト");
  assert.match(joinBody.data.playerToken, /^pt_/);

  const getResponse = await handler(
    createEvent("GET", `/v1/rooms/${joinBody.data.room.roomId}`, {
      headers: {
        "X-Omojan-Player-Token": joinBody.data.playerToken
      }
    })
  );
  const getBody = await parseResponse(getResponse);

  assert.equal(getResponse.statusCode, 200);
  assert.equal(getBody.ok, true);
  assert.equal(getBody.data.room.me.displayName, "ゲスト");
  assert.equal(getBody.data.room.game.players.length, 2);
});

test("POST /v1/rooms/:roomId/reconnect rejects missing token", async () => {
  const handler = createTestHandler();
  const createResponse = await handler(createEvent("POST", "/v1/rooms", { body: { displayName: "やまだ" } }));
  const createBody = await parseResponse(createResponse);

  const reconnectResponse = await handler(
    createEvent("POST", `/v1/rooms/${createBody.data.room.roomId}/reconnect`, {
      body: {}
    })
  );
  const reconnectBody = await parseResponse(reconnectResponse);

  assert.equal(reconnectResponse.statusCode, 401);
  assert.equal(reconnectBody.ok, false);
  assert.equal(reconnectBody.error.code, "PLAYER_TOKEN_INVALID");
});

test("POST /v1/rooms/:roomId/start-player updates start player and rotated order", async () => {
  const handler = createTestHandler();
  const createResponse = await handler(createEvent("POST", "/v1/rooms", { body: { displayName: "ホスト", playerCount: 3 } }));
  const createBody = await parseResponse(createResponse);

  const guestResponse = await handler(
    createEvent("POST", "/v1/rooms/join", {
      body: {
        inviteCode: createBody.data.room.inviteCode,
        displayName: "ゲスト"
      }
    })
  );
  const guestBody = await parseResponse(guestResponse);
  const targetPlayerId = guestBody.data.room.game.players.find((player) => player.displayName === "ゲスト").playerId;

  const startPlayerResponse = await handler(
    createEvent("POST", `/v1/rooms/${createBody.data.room.roomId}/start-player`, {
      headers: {
        "X-Omojan-Player-Token": createBody.data.playerToken
      },
      body: {
        startPlayerId: targetPlayerId
      }
    })
  );
  const startPlayerBody = await parseResponse(startPlayerResponse);

  assert.equal(startPlayerResponse.statusCode, 200);
  assert.equal(startPlayerBody.ok, true);
  assert.equal(startPlayerBody.data.room.startPlayerId, targetPlayerId);
  assert.equal(startPlayerBody.data.room.playerOrder[0], targetPlayerId);
});

test("POST /v1/rooms still returns not implemented for round APIs", async () => {
  const handler = createTestHandler();
  const response = await handler(createEvent("POST", "/v1/rooms/room_x/start", { body: { deckId: "default" } }));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 501);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "NOT_IMPLEMENTED");
});
