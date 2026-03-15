const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const MOCK_DIR = path.join(ROOT_DIR, "mock_api");
const ROOM_TTL_SECONDS = 60 * 60 * 24 * 3;

const defaultDeck = readJson("deck_default.json").data;
const recentChampions = readJson("champions_recent.json").data.items;

let awsSdkModules = null;

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

function domainError(statusCode, code, message, retryable = false) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.retryable = retryable;
  return error;
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

function parseRoute(method, pathname) {
  const routes = [
    { method: "GET", pattern: /^\/v1\/health$/, route: "health" },
    { method: "GET", pattern: /^\/v1\/champions\/recent$/, route: "getChampionsRecent" },
    { method: "GET", pattern: /^\/v1\/admin\/decks\/([^/]+)$/, route: "getDeck" },
    { method: "POST", pattern: /^\/v1\/rooms$/, route: "createRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/join$/, route: "joinRoom" },
    { method: "GET", pattern: /^\/v1\/rooms\/([^/]+)$/, route: "getRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/reconnect$/, route: "reconnectRoom" },
    { method: "POST", pattern: /^\/v1\/rooms\/([^/]+)\/start-player$/, route: "startPlayer" },
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
    region: process.env.AWS_REGION || "",
    implementedRoutes: ["rooms:create", "rooms:join", "rooms:get", "rooms:reconnect", "rooms:start-player"]
  });
}

function handleGetChampionsRecent(event) {
  const requestedLimit = Number(event.queryStringParameters?.limit || "5");
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5;
  return ok({
    items: recentChampions.slice(0, limit)
  });
}

function handleGetDeck(deckId) {
  if (deckId !== "default") {
    return fail(404, "DECK_NOT_FOUND", "指定されたデッキは存在しません。");
  }
  return ok(defaultDeck);
}

function handleNotImplemented(pathname) {
  return fail(
    501,
    "NOT_IMPLEMENTED",
    `${pathname} は Lambda 雛形のみ作成済みです。次に DynamoDB 実装を接続します。`
  );
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((headerName) => headerName.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : "";
}

function normalizeDisplayName(value) {
  return String(value || "").trim().slice(0, 20) || "あなた";
}

function normalizePlayerCount(value) {
  const count = Number(value);
  return [2, 3, 4].includes(count) ? count : 4;
}

function hashPlayerToken(playerToken) {
  return `sha256:${crypto.createHash("sha256").update(playerToken).digest("hex")}`;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function makeInviteCode() {
  return `OMO-${String(Math.floor(1000 + Math.random() * 9000))}`;
}

function createEmptyRounds() {
  return [
    { roundIndex: 0, label: "ラウンド1", wind: "東一局", phaseStatus: "pending", submissions: [], voteSummary: null, winner: null },
    { roundIndex: 1, label: "ラウンド2", wind: "東二局", phaseStatus: "pending", submissions: [], voteSummary: null, winner: null },
    { roundIndex: 2, label: "ラウンド3", wind: "東三局", phaseStatus: "pending", submissions: [], voteSummary: null, winner: null }
  ];
}

function createRoomState(params) {
  const { roomId, inviteCode, displayName, playerCount, playerId, playerTokenHash, issuedAt } = params;
  const expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;

  return {
    PK: `ROOM#${roomId}`,
    SK: "STATE",
    entityType: "RoomState",
    roomId,
    inviteCode,
    revision: 1,
    status: "lobby",
    hostPlayerId: playerId,
    playerCount,
    startPlayerId: null,
    playerOrder: [playerId],
    players: [
      {
        playerId,
        displayName,
        isHost: true,
        seatOrder: 1,
        joinedAt: issuedAt,
        isConnected: true,
        playerTokenHash,
        lastSeenAt: issuedAt,
        usedTileIds: [],
        handCount: 0
      }
    ],
    game: {
      phase: "lobby",
      roundIndex: null,
      currentTurnPlayerId: null,
      deckId: null,
      deckVersion: null,
      initialHands: {},
      rounds: createEmptyRounds(),
      finalVote: null,
      champion: null
    },
    createdAt: issuedAt,
    updatedAt: issuedAt,
    expiresAt
  };
}

function createInviteLookup(room) {
  return {
    PK: `INVITE#${room.inviteCode}`,
    SK: `ROOM#${room.roomId}`,
    entityType: "InviteLookup",
    roomId: room.roomId,
    inviteCode: room.inviteCode,
    status: room.status,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    expiresAt: room.expiresAt
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPlayerByToken(room, playerToken) {
  const playerTokenHash = hashPlayerToken(playerToken);
  return room.players.find((player) => player.playerTokenHash === playerTokenHash) || null;
}

function rotatePlayerOrder(playerIds, startPlayerId) {
  const startIndex = playerIds.indexOf(startPlayerId);
  if (startIndex === -1) {
    return playerIds;
  }
  return [...playerIds.slice(startIndex), ...playerIds.slice(0, startIndex)];
}

function derivePlayerOrder(room) {
  const playerIds = [...room.players]
    .sort((left, right) => left.seatOrder - right.seatOrder)
    .map((player) => player.playerId);

  if (room.startPlayerId) {
    return rotatePlayerOrder(playerIds, room.startPlayerId);
  }
  return playerIds;
}

function toPlayerView(player) {
  return {
    playerId: player.playerId,
    displayName: player.displayName,
    isHost: player.isHost,
    seatOrder: player.seatOrder,
    isConnected: Boolean(player.isConnected),
    handCount: Number(player.handCount || 0),
    usedTileIds: Array.isArray(player.usedTileIds) ? player.usedTileIds : []
  };
}

function buildMyHand(room, mePlayer) {
  const initialHands = room.game?.initialHands?.[mePlayer.playerId] || [];
  const usedTileIds = new Set(mePlayer.usedTileIds || []);
  return initialHands.map((tile) => ({
    tileId: tile.tileId,
    text: tile.text,
    isUsed: usedTileIds.has(tile.tileId)
  }));
}

function mapRoomResponse(room, mePlayer) {
  const players = [...room.players].sort((left, right) => left.seatOrder - right.seatOrder);
  return {
    roomId: room.roomId,
    inviteCode: room.inviteCode,
    revision: room.revision,
    status: room.status,
    hostPlayerId: room.hostPlayerId,
    playerCount: room.playerCount,
    startPlayerId: room.startPlayerId,
    playerOrder: Array.isArray(room.playerOrder) && room.playerOrder.length ? room.playerOrder : derivePlayerOrder(room),
    game: {
      phase: room.game?.phase || "lobby",
      roundIndex: room.game?.roundIndex ?? null,
      currentTurnPlayerId: room.game?.currentTurnPlayerId ?? null,
      players: players.map(toPlayerView),
      rounds: Array.isArray(room.game?.rounds) ? clone(room.game.rounds) : createEmptyRounds(),
      finalVote: room.game?.finalVote ? clone(room.game.finalVote) : null,
      champion: room.game?.champion ? clone(room.game.champion) : null
    },
    me: {
      playerId: mePlayer.playerId,
      displayName: mePlayer.displayName,
      isHost: mePlayer.isHost,
      reconnectTokenIssued: true
    },
    myHand: buildMyHand(room, mePlayer)
  };
}

function toRoomPayload(room, mePlayer, playerToken = null) {
  const payload = {
    room: mapRoomResponse(room, mePlayer)
  };
  if (playerToken) {
    payload.playerToken = playerToken;
  }
  return payload;
}

function toConditionalFailure(error) {
  return error && (error.name === "ConditionalCheckFailedException" || error.code === "ConditionalCheckFailedException");
}

async function loadAwsSdkModules() {
  if (!awsSdkModules) {
    const dynamodb = require("@aws-sdk/client-dynamodb");
    const dynamodbDocument = require("@aws-sdk/lib-dynamodb");
    awsSdkModules = {
      DynamoDBClient: dynamodb.DynamoDBClient,
      DynamoDBDocumentClient: dynamodbDocument.DynamoDBDocumentClient,
      GetCommand: dynamodbDocument.GetCommand,
      PutCommand: dynamodbDocument.PutCommand,
      QueryCommand: dynamodbDocument.QueryCommand,
      TransactWriteCommand: dynamodbDocument.TransactWriteCommand
    };
  }
  return awsSdkModules;
}

async function createDynamoRoomRepository(options = {}) {
  const modules = await loadAwsSdkModules();
  const tableName = options.tableName || process.env.APP_TABLE_NAME || "OmojanApp";
  const client = options.client || new modules.DynamoDBClient({});
  const documentClient =
    options.documentClient ||
    modules.DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true
      }
    });

  async function getRoomItem(roomId) {
    const response = await documentClient.send(
      new modules.GetCommand({
        TableName: tableName,
        Key: {
          PK: `ROOM#${roomId}`,
          SK: "STATE"
        }
      })
    );
    return response.Item || null;
  }

  async function putRoomItem(room, expectedRevision) {
    const command = new modules.PutCommand({
      TableName: tableName,
      Item: room,
      ConditionExpression:
        expectedRevision === null ? "attribute_not_exists(PK)" : "#revision = :expectedRevision",
      ExpressionAttributeNames: expectedRevision === null ? undefined : { "#revision": "revision" },
      ExpressionAttributeValues: expectedRevision === null ? undefined : { ":expectedRevision": expectedRevision }
    });
    await documentClient.send(command);
  }

  async function findInvite(inviteCode) {
    const response = await documentClient.send(
      new modules.QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": `INVITE#${inviteCode}`
        },
        Limit: 1
      })
    );
    return response.Items?.[0] || null;
  }

  return {
    async createRoom({ displayName, playerCount }) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const issuedAt = nowIso();
        const roomId = makeId("room");
        const inviteCode = makeInviteCode();
        const playerId = makeId("player");
        const playerToken = makeId("pt");
        const room = createRoomState({
          roomId,
          inviteCode,
          displayName,
          playerCount,
          playerId,
          playerTokenHash: hashPlayerToken(playerToken),
          issuedAt
        });
        const inviteItem = createInviteLookup(room);

        try {
          await documentClient.send(
            new modules.TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: tableName,
                    Item: room,
                    ConditionExpression: "attribute_not_exists(PK)"
                  }
                },
                {
                  Put: {
                    TableName: tableName,
                    Item: inviteItem,
                    ConditionExpression: "attribute_not_exists(PK)"
                  }
                }
              ]
            })
          );
          return { room, mePlayer: room.players[0], playerToken };
        } catch (error) {
          if (toConditionalFailure(error) || error.name === "TransactionCanceledException") {
            continue;
          }
          throw error;
        }
      }
      throw domainError(409, "CONFLICT_RETRY", "ルーム作成が競合しました。もう一度お試しください。", true);
    },

    async joinRoom({ inviteCode, displayName }) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const inviteItem = await findInvite(inviteCode);
        if (!inviteItem?.roomId) {
          throw domainError(404, "INVITE_NOT_FOUND", "招待コードが見つかりません。");
        }

        const room = await getRoomItem(inviteItem.roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        if (room.status !== "lobby" || room.game?.phase !== "lobby") {
          throw domainError(409, "ROOM_ALREADY_STARTED", "すでにゲームが始まっています。");
        }
        if (room.players.length >= room.playerCount) {
          throw domainError(409, "ROOM_FULL", "このルームは満員です。");
        }

        const issuedAt = nowIso();
        const playerId = makeId("player");
        const playerToken = makeId("pt");
        const updatedRoom = clone(room);
        updatedRoom.players.push({
          playerId,
          displayName,
          isHost: false,
          seatOrder: updatedRoom.players.length + 1,
          joinedAt: issuedAt,
          isConnected: true,
          playerTokenHash: hashPlayerToken(playerToken),
          lastSeenAt: issuedAt,
          usedTileIds: [],
          handCount: 0
        });
        updatedRoom.playerOrder = derivePlayerOrder(updatedRoom);
        updatedRoom.updatedAt = issuedAt;
        updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
        updatedRoom.revision += 1;

        try {
          await putRoomItem(updatedRoom, room.revision);
          const mePlayer = updatedRoom.players.find((player) => player.playerId === playerId);
          return { room: updatedRoom, mePlayer, playerToken };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "参加処理が競合しました。もう一度お試しください。", true);
    },

    async getRoom(roomId, playerToken) {
      const room = await getRoomItem(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      return { room, mePlayer };
    },

    async reconnectRoom(roomId, playerToken) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }

        const updatedRoom = clone(room);
        const player = updatedRoom.players.find((item) => item.playerId === mePlayer.playerId);
        player.isConnected = true;
        player.lastSeenAt = nowIso();
        updatedRoom.updatedAt = player.lastSeenAt;
        updatedRoom.expiresAt = Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
        updatedRoom.revision += 1;

        try {
          await putRoomItem(updatedRoom, room.revision);
          return { room: updatedRoom, mePlayer: player };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "再接続処理が競合しました。もう一度お試しください。", true);
    },

    async setStartPlayer(roomId, playerToken, startPlayerId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = await getRoomItem(roomId);
        if (!room) {
          throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
        }
        const mePlayer = getPlayerByToken(room, playerToken);
        if (!mePlayer) {
          throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
        }
        if (!mePlayer.isHost) {
          throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
        }
        if (room.game?.phase !== "lobby") {
          throw domainError(409, "INVALID_PHASE", "lobby ではないため実行できません。");
        }
        if (!room.players.some((player) => player.playerId === startPlayerId)) {
          throw domainError(400, "INVALID_TARGET", "開始プレイヤーが不正です。");
        }

        const updatedRoom = clone(room);
        updatedRoom.startPlayerId = startPlayerId;
        updatedRoom.playerOrder = rotatePlayerOrder(
          updatedRoom.players
            .slice()
            .sort((left, right) => left.seatOrder - right.seatOrder)
            .map((player) => player.playerId),
          startPlayerId
        );
        updatedRoom.updatedAt = nowIso();
        updatedRoom.revision += 1;

        try {
          await putRoomItem(updatedRoom, room.revision);
          const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
          return { room: updatedRoom, mePlayer: updatedMePlayer };
        } catch (error) {
          if (toConditionalFailure(error)) {
            continue;
          }
          throw error;
        }
      }

      throw domainError(409, "CONFLICT_RETRY", "開始順の更新が競合しました。もう一度お試しください。", true);
    }
  };
}

function createMemoryRoomRepository() {
  const rooms = new Map();
  const invites = new Map();

  function saveRoom(room) {
    rooms.set(room.roomId, clone(room));
  }

  return {
    async createRoom({ displayName, playerCount }) {
      const issuedAt = nowIso();
      const roomId = makeId("room");
      const inviteCode = makeInviteCode();
      const playerId = makeId("player");
      const playerToken = makeId("pt");
      const room = createRoomState({
        roomId,
        inviteCode,
        displayName,
        playerCount,
        playerId,
        playerTokenHash: hashPlayerToken(playerToken),
        issuedAt
      });
      saveRoom(room);
      invites.set(inviteCode, roomId);
      return { room: clone(room), mePlayer: clone(room.players[0]), playerToken };
    },

    async joinRoom({ inviteCode, displayName }) {
      const roomId = invites.get(inviteCode);
      if (!roomId) {
        throw domainError(404, "INVITE_NOT_FOUND", "招待コードが見つかりません。");
      }
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      if (room.status !== "lobby" || room.game?.phase !== "lobby") {
        throw domainError(409, "ROOM_ALREADY_STARTED", "すでにゲームが始まっています。");
      }
      if (room.players.length >= room.playerCount) {
        throw domainError(409, "ROOM_FULL", "このルームは満員です。");
      }

      const issuedAt = nowIso();
      const playerId = makeId("player");
      const playerToken = makeId("pt");
      const updatedRoom = clone(room);
      updatedRoom.players.push({
        playerId,
        displayName,
        isHost: false,
        seatOrder: updatedRoom.players.length + 1,
        joinedAt: issuedAt,
        isConnected: true,
        playerTokenHash: hashPlayerToken(playerToken),
        lastSeenAt: issuedAt,
        usedTileIds: [],
        handCount: 0
      });
      updatedRoom.playerOrder = derivePlayerOrder(updatedRoom);
      updatedRoom.updatedAt = issuedAt;
      updatedRoom.revision += 1;
      saveRoom(updatedRoom);
      const mePlayer = updatedRoom.players.find((player) => player.playerId === playerId);
      return { room: clone(updatedRoom), mePlayer: clone(mePlayer), playerToken };
    },

    async getRoom(roomId, playerToken) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      return { room: clone(room), mePlayer: clone(mePlayer) };
    },

    async reconnectRoom(roomId, playerToken) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      const updatedRoom = clone(room);
      const player = updatedRoom.players.find((item) => item.playerId === mePlayer.playerId);
      player.isConnected = true;
      player.lastSeenAt = nowIso();
      updatedRoom.updatedAt = player.lastSeenAt;
      updatedRoom.revision += 1;
      saveRoom(updatedRoom);
      return { room: clone(updatedRoom), mePlayer: clone(player) };
    },

    async setStartPlayer(roomId, playerToken, startPlayerId) {
      const room = rooms.get(roomId);
      if (!room) {
        throw domainError(404, "ROOM_NOT_FOUND", "指定された room は存在しません。");
      }
      const mePlayer = getPlayerByToken(room, playerToken);
      if (!mePlayer) {
        throw domainError(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
      }
      if (!mePlayer.isHost) {
        throw domainError(403, "NOT_HOST", "ホストのみ実行できます。");
      }
      if (room.game?.phase !== "lobby") {
        throw domainError(409, "INVALID_PHASE", "lobby ではないため実行できません。");
      }
      if (!room.players.some((player) => player.playerId === startPlayerId)) {
        throw domainError(400, "INVALID_TARGET", "開始プレイヤーが不正です。");
      }

      const updatedRoom = clone(room);
      updatedRoom.startPlayerId = startPlayerId;
      updatedRoom.playerOrder = rotatePlayerOrder(
        updatedRoom.players
          .slice()
          .sort((left, right) => left.seatOrder - right.seatOrder)
          .map((player) => player.playerId),
        startPlayerId
      );
      updatedRoom.updatedAt = nowIso();
      updatedRoom.revision += 1;
      saveRoom(updatedRoom);
      const updatedMePlayer = updatedRoom.players.find((player) => player.playerId === mePlayer.playerId);
      return { room: clone(updatedRoom), mePlayer: clone(updatedMePlayer) };
    },

    debugGetStoredRoom(roomId) {
      const room = rooms.get(roomId);
      return room ? clone(room) : null;
    }
  };
}

function toErrorResponse(error) {
  if (error?.statusCode && error?.code) {
    return fail(error.statusCode, error.code, error.message, Boolean(error.retryable));
  }
  return fail(500, "INTERNAL_ERROR", "サーバー内部でエラーが発生しました。", true);
}

function createHandler(options = {}) {
  const roomRepositoryPromise = options.roomRepository
    ? Promise.resolve(options.roomRepository)
    : createDynamoRoomRepository(options.dynamo || {});

  return async function lambdaHandler(event) {
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

    try {
      switch (matched.route) {
        case "health":
          return handleHealth();
        case "getChampionsRecent":
          return handleGetChampionsRecent(event);
        case "getDeck":
          return handleGetDeck(matched.params[0]);
        case "createRoom": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.createRoom({
            displayName: normalizeDisplayName(body.displayName),
            playerCount: normalizePlayerCount(body.playerCount)
          });
          return ok(toRoomPayload(result.room, result.mePlayer, result.playerToken));
        }
        case "joinRoom": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const inviteCode = String(body.inviteCode || "").trim();
          if (!inviteCode) {
            return fail(400, "INVITE_NOT_FOUND", "招待コードが必要です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.joinRoom({
            inviteCode,
            displayName: normalizeDisplayName(body.displayName)
          });
          return ok(toRoomPayload(result.room, result.mePlayer, result.playerToken));
        }
        case "getRoom": {
          const repository = await roomRepositoryPromise;
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const result = await repository.getRoom(matched.params[0], playerToken);
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "reconnectRoom": {
          const repository = await roomRepositoryPromise;
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const result = await repository.reconnectRoom(matched.params[0], playerToken);
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "startPlayer": {
          const body = parseBody(event);
          if (!body) {
            return fail(400, "INVALID_JSON", "JSON の形式が不正です。");
          }
          const playerToken = getHeader(event, "X-Omojan-Player-Token");
          if (!playerToken) {
            return fail(401, "PLAYER_TOKEN_INVALID", "playerToken が必要です。");
          }
          const startPlayerId = String(body.startPlayerId || "").trim();
          if (!startPlayerId) {
            return fail(400, "INVALID_TARGET", "開始プレイヤーが不正です。");
          }
          const repository = await roomRepositoryPromise;
          const result = await repository.setStartPlayer(matched.params[0], playerToken, startPlayerId);
          return ok(toRoomPayload(result.room, result.mePlayer));
        }
        case "notImplemented":
          return handleNotImplemented(pathname);
        default:
          return fail(404, "ROUTE_NOT_FOUND", "指定された API は存在しません。");
      }
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

let defaultHandler = null;

async function handler(event) {
  if (!defaultHandler) {
    defaultHandler = createHandler();
  }
  return defaultHandler(event);
}

module.exports = {
  handler,
  createHandler,
  createMemoryRoomRepository,
  createDynamoRoomRepository,
  parseRoute
};
