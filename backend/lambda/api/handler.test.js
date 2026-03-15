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
  return JSON.parse(response.body || "{}");
}

test("GET /v1/health returns lambda scaffold metadata", async () => {
  process.env.APP_STAGE = "dev";
  process.env.APP_TABLE_NAME = "OmojanApp";

  const response = await handler(createEvent("GET", "/v1/health"));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.mode, "lambda-scaffold");
  assert.equal(body.data.tableName, "OmojanApp");
});

test("GET /v1/champions/recent returns recent items", async () => {
  const response = await handler(createEvent("GET", "/v1/champions/recent", { query: { limit: "2" } }));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.items.length, 2);
});

test("POST /v1/rooms is not implemented in lambda scaffold yet", async () => {
  const response = await handler(createEvent("POST", "/v1/rooms", { body: { displayName: "あなた" } }));
  const body = await parseResponse(response);

  assert.equal(response.statusCode, 501);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "NOT_IMPLEMENTED");
});
