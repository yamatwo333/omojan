const test = require("node:test");
const assert = require("node:assert/strict");
const { handler } = require("./handler");

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
  return JSON.parse(response.body);
}

test("GET /v1/champions/recent returns recent items", async () => {
  const response = await handler(createEvent("GET", "/v1/champions/recent", { query: { limit: "3" } }));
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.items.length, 3);
});

test("GET /v1/rooms/:roomId returns room scenario", async () => {
  const response = await handler(createEvent("GET", "/v1/rooms/room_omo_2048", { query: { scenario: "round_vote" } }));
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.room.game.phase, "round_vote");
});

test("POST /v1/rooms creates mock host room", async () => {
  const response = await handler(
    createEvent("POST", "/v1/rooms", {
      body: {
        displayName: "テストホスト",
        playerCount: 3
      }
    })
  );
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.room.me.isHost, true);
  assert.equal(body.data.room.playerCount, 3);
});

test("POST /v1/rooms/:roomId/reconnect requires player token", async () => {
  const response = await handler(createEvent("POST", "/v1/rooms/room_omo_2048/reconnect"));
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 401);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "PLAYER_TOKEN_INVALID");
});

test("POST submit endpoint is stubbed with not implemented", async () => {
  const response = await handler(createEvent("POST", "/v1/rooms/room_omo_2048/rounds/0/submit"));
  const body = await parseResponse(response);
  assert.equal(response.statusCode, 501);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "NOT_IMPLEMENTED");
});
