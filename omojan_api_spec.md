# おもじゃん API 仕様書

## 1. この文書の目的

この文書は、`おもじゃん` の初版で使う API を具体化するための文書です。

- エンドポイント
- リクエスト / レスポンス
- 誰が呼べるか
- どの phase で呼べるか

を整理します。

## 2. 基本方針

- API は `行動単位` で切る
- 画面遷移は API ではなく、返ってきた `phase` から決める
- 少人数ゲームなので、更新後は最新の `room` 全体を返す
- 初版では REST + JSON を採用する

## 3. API 共通仕様

### 3-1. ベースパス

```txt
/v1
```

### 3-2. リクエスト形式

- `Content-Type: application/json`
- レスポンスも JSON

### 3-3. 認証 / 識別

初版ではログインを使わないため、プレイヤー識別は `playerToken` で行います。

#### 使い方

- ルーム作成 / 参加時に `playerToken` を発行する
- ブラウザのローカル保存領域に保持する
- 以降のルーム API はヘッダーで送る

```txt
X-Omojan-Player-Token: <playerToken>
```

### 3-4. レスポンス共通形

基本の成功レスポンスは次です。

```ts
type ApiSuccess<T> = {
  ok: true;
  data: T;
  serverTime: string;
};
```

エラーは次です。

```ts
type ApiError = {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
  serverTime: string;
};
```

### 3-5. 主要エラーコード

- `ROOM_NOT_FOUND`
- `INVITE_NOT_FOUND`
- `ROOM_FULL`
- `ROOM_ALREADY_STARTED`
- `PLAYER_NOT_IN_ROOM`
- `PLAYER_TOKEN_INVALID`
- `NOT_HOST`
- `INVALID_PHASE`
- `NOT_YOUR_TURN`
- `ALREADY_SUBMITTED`
- `ALREADY_VOTED`
- `SELF_VOTE_FORBIDDEN`
- `INVALID_TARGET`
- `CONFLICT_RETRY`

## 4. 主要データ型

### 4-1. RoomResponse

```ts
type RoomResponse = {
  roomId: string;
  inviteCode: string;
  revision: number;
  status: "lobby" | "playing" | "finished";
  hostPlayerId: string;
  playerCount: 2 | 3 | 4;
  startPlayerId: string | null;
  playerOrder: string[];
  game: GameStateResponse;
  me: {
    playerId: string;
    displayName: string;
    isHost: boolean;
    reconnectTokenIssued: boolean;
  };
  myHand: MyHandTileView[];
};
```

### 4-2. GameStateResponse

```ts
type GameStateResponse = {
  phase:
    | "lobby"
    | "round_submit"
    | "round_vote"
    | "round_revote"
    | "round_host_decide"
    | "round_result"
    | "final_vote"
    | "final_revote"
    | "final_host_decide"
    | "final_result";
  roundIndex: number | null;
  currentTurnPlayerId: string | null;
  players: PlayerView[];
  rounds: RoundView[];
  finalVote: FinalVoteView | null;
  champion: ChampionView | null;
  reveal: RevealView | null;
};
```

### 4-3. PlayerView

```ts
type PlayerView = {
  playerId: string;
  displayName: string;
  isHost: boolean;
  seatOrder: number;
  isConnected: boolean;
  handCount: number;
  usedTileIds: string[];
};
```

### 4-4. MyHandTileView

```ts
type MyHandTileView = {
  tileId: string;
  text: string;
  isUsed: boolean;
};
```

### 4-5. SubmissionView

```ts
type SubmissionView = {
  playerId: string;
  displayName: string;
  phrase: string;
  fontId: string;
  renderedLines: string[];
  submittedAt: string;
};
```

### 4-6. RoundView

```ts
type RoundView = {
  roundIndex: number;
  label: string;
  wind: string;
  phaseStatus: "pending" | "submit" | "vote" | "revote" | "host_decide" | "finished";
  submissions: SubmissionView[];
  votedPlayerIds: string[];
  revotedPlayerIds: string[];
  voteSummary: {
    counts: Array<{
      playerId: string;
      displayName: string;
      phrase: string;
      count: number;
    }>;
    tiedPlayerIds: string[];
  } | null;
  winner: ChampionView | null;
};
```

### 4-6a. RevealView

```ts
type RevealView = {
  revealId: string;
  kind: "submission" | "round_winner" | "champion";
  roundIndex: number | null;
  displayName: string;
  playerId: string;
  phrase: string;
  fontId: string;
  renderedLines: string[];
  acknowledgedPlayerIds: string[];
};
```

### 4-7. FinalVoteView

```ts
type FinalVoteView = {
  phaseStatus: "vote" | "revote" | "host_decide" | "finished";
  votedPlayerIds: string[];
  revotedPlayerIds: string[];
  candidates: Array<{
    candidateId: string;
    roundIndex: number;
    playerId: string;
    displayName: string;
    phrase: string;
    fontId: string;
    renderedLines: string[];
  }>;
  voteSummary: {
    counts: Array<{
      candidateId: string;
      displayName: string;
      phrase: string;
      count: number;
    }>;
    tiedCandidateIds: string[];
  } | null;
  winner: ChampionView | null;
};
```

### 4-8. ChampionView

```ts
type ChampionView = {
  playerId: string;
  displayName: string;
  phrase: string;
  fontId: string;
  renderedLines: string[];
  voteCount: number;
  source: "initial" | "revote" | "host_decide";
};
```

### 4-9. SubmissionPayload

```ts
type SubmissionPayload = {
  tileIds: [string, string];
  tileOrder: [0 | 1, 0 | 1];
  phrase: string;
  fontId: string;
  lineMode: "boundary" | "manual" | "single";
  manualBreaks: number[];
  renderedLines: string[];
};
```

## 5. ルーム系 API

### 5-1. ルーム作成

`POST /v1/rooms`

- 呼び出し者
  - 誰でも
- 用途
  - ホストとしてルームを作る

#### Request

```json
{
  "displayName": "やまだ",
  "playerCount": 4
}
```

#### Response

```json
{
  "ok": true,
  "data": {
    "playerToken": "pt_...",
    "room": {}
  },
  "serverTime": "2026-03-15T11:00:00Z"
}
```

### 5-2. ルーム参加

`POST /v1/rooms/join`

- 呼び出し者
  - 誰でも
- 用途
  - 招待コードからルームへ参加する

#### Request

```json
{
  "inviteCode": "OMO-2048",
  "displayName": "たなか"
}
```

#### Response

```json
{
  "ok": true,
  "data": {
    "playerToken": "pt_...",
    "room": {}
  }
}
```

### 5-3. ルーム再接続

`POST /v1/rooms/{roomId}/reconnect`

- 呼び出し者
  - 既に `playerToken` を持っているプレイヤー
- 用途
  - 同じ端末・同じブラウザから進行中ルームへ復帰する

#### Request

```json
{}
```

#### Header

```txt
X-Omojan-Player-Token: pt_...
```

#### Response

- 最新の `room` を返す

### 5-4. ルーム状態取得

`GET /v1/rooms/{roomId}`

- 呼び出し者
  - 参加済みプレイヤー
- 用途
  - 最新状態の取得

#### Response

- `RoomResponse`

### 5-5. 開始順設定

`POST /v1/rooms/{roomId}/start-player`

- 呼び出し者
  - ホストのみ
- 呼べる phase
  - `lobby`

#### Request

```json
{
  "startPlayerId": "player_you"
}
```

#### Response

- 更新後の `room`

### 5-6. ゲーム開始

`POST /v1/rooms/{roomId}/start`

- 呼び出し者
  - ホストのみ
- 呼べる phase
  - `lobby`

#### Request

```json
{
  "deckId": "default"
}
```

#### Response

- 更新後の `room`

## 6. ラウンド進行 API

### 6-1. ワード提出

`POST /v1/rooms/{roomId}/rounds/{roundIndex}/submit`

- 呼び出し者
  - 現在手番のプレイヤー
- 呼べる phase
  - `round_submit`

#### Request

```json
{
  "tileIds": ["tile_01", "tile_07"],
  "tileOrder": [1, 0],
  "phrase": "謝罪現場猫",
  "fontId": "broadcast",
  "lineMode": "manual",
  "manualBreaks": [2],
  "renderedLines": ["謝罪", "現場猫"]
}
```

#### バリデーション

- 選択牌は 2 枚ちょうど
- そのプレイヤーの手札に存在する
- まだ未使用である
- 既に提出済みではない

#### Response

- 更新後の `room`

### 6-2. ラウンド投票

`POST /v1/rooms/{roomId}/rounds/{roundIndex}/vote`

- 呼び出し者
  - 参加プレイヤー
- 呼べる phase
  - `round_vote`

#### Request

```json
{
  "targetPlayerId": "player_host"
}
```

#### バリデーション

- 自分自身には投票できない
- ラウンド候補に存在する
- 既に投票済みではない

#### Response

- 更新後の `room`

### 6-3. ラウンド再投票

`POST /v1/rooms/{roomId}/rounds/{roundIndex}/revote`

- 呼び出し者
  - 参加プレイヤー
- 呼べる phase
  - `round_revote`

#### Request

```json
{
  "targetPlayerId": "player_tanaka"
}
```

#### Response

- 更新後の `room`

### 6-4. ラウンドホスト裁定

`POST /v1/rooms/{roomId}/rounds/{roundIndex}/host-decision`

- 呼び出し者
  - ホストのみ
- 呼べる phase
  - `round_host_decide`

#### Request

```json
{
  "winnerPlayerId": "player_tanaka"
}
```

#### Response

- 更新後の `room`

### 6-5. 次ラウンドへ進む

`POST /v1/rooms/{roomId}/rounds/{roundIndex}/proceed`

- 呼び出し者
  - ホストのみ
- 呼べる phase
  - `round_result`

#### 用途

- ラウンド 1, 2 の結果画面から次ラウンドへ進む
- ラウンド 3 の場合は最終投票へ進む

#### Request

```json
{}
```

#### Response

- 更新後の `room`

## 7. 最終投票 API

### 7-1. 最終投票

`POST /v1/rooms/{roomId}/final-vote`

- 呼び出し者
  - 参加プレイヤー
- 呼べる phase
  - `final_vote`

#### Request

```json
{
  "candidateId": "final_round2"
}
```

#### Response

- 更新後の `room`

### 7-2. 最終再投票

`POST /v1/rooms/{roomId}/final-revote`

- 呼び出し者
  - 参加プレイヤー
- 呼べる phase
  - `final_revote`

#### Request

```json
{
  "candidateId": "final_round3"
}
```

#### Response

- 更新後の `room`

### 7-3. 最終ホスト裁定

`POST /v1/rooms/{roomId}/final-host-decision`

- 呼び出し者
  - ホストのみ
- 呼べる phase
  - `final_host_decide`

#### Request

```json
{
  "candidateId": "final_round1"
}
```

#### Response

- 更新後の `room`

### 7-4. 再戦 / 最初から

`POST /v1/rooms/{roomId}/restart`

- 呼び出し者
  - ホストのみ
- 呼べる phase
  - `final_result`

#### 用途

- 同じメンバーのままロビー相当の状態へ戻す

#### Request

```json
{}
```

#### Response

- 更新後の `room`

## 8. 履歴 API

### 8-1. 最近の優勝ワード取得

`GET /v1/champions/recent?limit=5`

- 呼び出し者
  - 誰でも
- 用途
  - ロビーに表示する全体共通の履歴取得
- 補足
  - 新しく総合優勝が確定したワードは、保存済み履歴の先頭に追加される

#### Response

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "championId": "ch_20260315_001",
        "phrase": "現場大洪水",
        "displayName": "やまだ",
        "wonAt": "2026-03-15T10:59:00Z"
      }
    ]
  }
}
```

## 9. 運営用 API

初版ではプレイヤー向けのデッキ編集 UI は作りません。  
ただし、運営側がデッキを更新できるようにしておきます。

### 9-1. デッキ取得

`GET /v1/admin/decks/{deckId}`

Header:

`X-Omojan-Admin-Passcode: <shared-passcode>`

### 9-2. デッキ更新

`PUT /v1/admin/decks/{deckId}`

Header:

`X-Omojan-Admin-Passcode: <shared-passcode>`

#### Request

```json
{
  "deckName": "default",
  "tiles": [
    { "tileId": "tile_001", "text": "現場猫", "enabled": true },
    { "tileId": "tile_002", "text": "謝罪会見", "enabled": true }
  ]
}
```

### 9-3. デッキ削除

`DELETE /v1/admin/decks/{deckId}`

補足:

- 初版では `default` デッキを削除不可にしてもよい
- 実運用では `enabled=false` で無効化する方が安全

## 10. ポーリング方針

初版では次の取得方針で十分です。

- 操作成功後は即時 `GET /rooms/{roomId}`
- 待機画面では 3〜5 秒おきに `GET /rooms/{roomId}`

## 11. 実装上の注意

- ルーム更新系 API は `revision` を見て楽観ロックする
- 同時更新競合時は `CONFLICT_RETRY` を返す
- 投票確定や提出確定のレスポンスは、画面差分ではなく最新 room を返す
- フロントは `phase` と `me` を見て画面を決める
- `round_vote / round_revote / final_vote / final_revote` では、必要に応じて `votedPlayerIds / revotedPlayerIds` で自分の行動済みを判定する
- 最終投票では、自分のワードしか候補に残っていないプレイヤーはその投票フェーズの必須投票者から外す
- モックデータは `mock_api/` 配下を参照する
