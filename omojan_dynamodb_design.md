# おもじゃん DynamoDB テーブル設計書

## 1. この文書の目的

この文書は、`おもじゃん` 初版の DynamoDB 設計を具体化するための文書です。

- テーブル構成
- キー設計
- アイテム種別
- アクセスパターン
- 更新戦略

を整理します。

## 2. 設計方針

初版では `1 テーブル構成` を採用します。

理由は次の通りです。

- 少人数・低トラフィックでアクセスパターンが少ない
- ルーム状態を 1 アイテムで持てる
- 招待コード、履歴、デッキを同一テーブルで扱える
- コストと運用をシンプルにできる

## 3. テーブル概要

### テーブル名

```txt
OmojanApp
```

### 主キー

- `PK` string
- `SK` string

### 追加属性

- `entityType`
- `createdAt`
- `updatedAt`
- `expiresAt`

### TTL

- `expiresAt` を TTL 属性として使う
- ルーム関連アイテムのみ TTL 対象

## 4. このテーブルで扱うアイテム

### 4-1. ルーム状態

```txt
PK = ROOM#<roomId>
SK = STATE
```

### 4-2. 招待コード逆引き

```txt
PK = INVITE#<inviteCode>
SK = ROOM#<roomId>
```

### 4-3. デッキメタ情報

```txt
PK = DECK#<deckId>
SK = META
```

### 4-4. デッキ牌

```txt
PK = DECK#<deckId>
SK = TILE#<tileId>
```

### 4-5. 全体共通の優勝ワード履歴

```txt
PK = CHAMPIONS
SK = TS#<wonAt>#ROOM#<roomId>
```

## 5. ルームアイテム設計

### 5-1. ROOM#... / STATE

初版では、1 ルームのゲーム状態を `1 アイテム` にまとめます。

理由:

- 最大 4 人、3 ラウンドなのでサイズが小さい
- 毎回 room 全体を返す API と相性がよい
- 実装が分かりやすい

### 属性例

```ts
{
  PK: "ROOM#r_01JPA3...",
  SK: "STATE",
  entityType: "RoomState",
  roomId: "r_01JPA3...",
  inviteCode: "OMO-2048",
  revision: 12,
  status: "playing",
  hostPlayerId: "player_host",
  playerCount: 4,
  startPlayerId: "player_you",
  playerOrder: ["player_you", "player_host", "player_tanaka", "player_miki"],
  players: [
    {
      playerId: "player_you",
      displayName: "あなた",
      isHost: false,
      joinedAt: "2026-03-15T11:00:00Z",
      isConnected: true,
      playerTokenHash: "sha256:...",
      lastSeenAt: "2026-03-15T11:02:00Z"
    }
  ],
  game: {
    phase: "round_vote",
    roundIndex: 1,
    currentTurnPlayerId: null,
    deckId: "default",
    deckVersion: 3,
    initialHands: {
      player_you: [
        { tileId: "tile_001", text: "現場猫" }
      ]
    },
    rounds: [],
    finalVote: null,
    champion: null
  },
  createdAt: "2026-03-15T11:00:00Z",
  updatedAt: "2026-03-15T11:02:00Z",
  expiresAt: 1770000000
}
```

### 5-2. なぜ playerTokenHash を持つか

初版ではログインを使わないため、`同じ端末・同じブラウザ` からの再接続は `playerToken` で復帰します。

- ブラウザは token を保存する
- サーバー側は `hash` だけ保存する
- 毎回ルーム取得時に token を照合する

## 6. 招待コード逆引きアイテム

### 6-1. INVITE#... / ROOM#...

```ts
{
  PK: "INVITE#OMO-2048",
  SK: "ROOM#r_01JPA3...",
  entityType: "InviteLookup",
  roomId: "r_01JPA3...",
  inviteCode: "OMO-2048",
  status: "playing",
  createdAt: "2026-03-15T11:00:00Z",
  updatedAt: "2026-03-15T11:02:00Z",
  expiresAt: 1770000000
}
```

### 6-2. 用途

- 招待コードからルームを引く
- ルーム作成時に重複を防ぐ

## 7. デッキ設計

### 7-1. DECK#... / META

```ts
{
  PK: "DECK#default",
  SK: "META",
  entityType: "DeckMeta",
  deckId: "default",
  deckName: "default",
  version: 3,
  status: "active",
  tileCount: 120,
  createdAt: "2026-03-01T00:00:00Z",
  updatedAt: "2026-03-15T10:00:00Z"
}
```

### 7-2. DECK#... / TILE#...

```ts
{
  PK: "DECK#default",
  SK: "TILE#tile_001",
  entityType: "DeckTile",
  deckId: "default",
  tileId: "tile_001",
  text: "現場猫",
  enabled: true,
  sortOrder: 1,
  createdAt: "2026-03-01T00:00:00Z",
  updatedAt: "2026-03-15T10:00:00Z"
}
```

### 7-3. この形にする理由

- 牌ごとの追加 / 更新 / 削除がしやすい
- `default` デッキの中身を運営側が変更できる
- 1 アイテムに全文字列を押し込まなくて済む

### 7-4. デッキ更新時の扱い

- ルーム開始時に `deckVersion` を room state に保存する
- あわせて `initialHands` も room state に固定保存する
- そのため、運営側がデッキを更新しても進行中ルームには影響しない
- 更新内容は `次に開始されるルーム` から反映する

## 8. 優勝履歴設計

### 8-1. CHAMPIONS / TS#...

```ts
{
  PK: "CHAMPIONS",
  SK: "TS#2026-03-15T10:59:00Z#ROOM#r_01JPA3...",
  entityType: "ChampionHistory",
  championId: "ch_20260315_001",
  roomId: "r_01JPA3...",
  inviteCode: "OMO-2048",
  playerId: "player_host",
  displayName: "やまだ",
  phrase: "現場大洪水",
  fontId: "classic",
  renderedLines: ["現場大洪水"],
  wonAt: "2026-03-15T10:59:00Z",
  createdAt: "2026-03-15T10:59:00Z"
}
```

### 8-2. 用途

- ロビーの最近 5 件表示
- 履歴一覧表示

## 9. GSI 方針

初版では `GSI なし` で始めます。

理由:

- 招待コード逆引きは専用アイテムで解決できる
- 履歴表示も固定 PK で解決できる
- 追加のインデックスコストを避けられる

将来、`プレイヤー別履歴` や `デッキ一覧管理` が増えたら GSI を追加検討します。

## 10. 主要アクセスパターン

### AP-01. ルーム作成

必要処理:

- `ROOM#... / STATE` を作る
- `INVITE#... / ROOM#...` を作る

使う API:

- `TransactWriteItems`

### AP-02. 招待コードで参加

必要処理:

1. `PK=INVITE#<inviteCode>` を `GetItem`
2. 得られた `roomId` で `ROOM#<roomId> / STATE` を `GetItem`
3. 条件付き `UpdateItem` で players を追加

### AP-03. ルーム状態取得

必要処理:

- `PK=ROOM#<roomId>, SK=STATE` を `GetItem`

### AP-04. 提出 / 投票 / 再投票 / ホスト裁定

必要処理:

- `ROOM#<roomId> / STATE` を `UpdateItem`
- `revision` を条件に楽観ロック

### AP-05. ゲーム終了時の優勝履歴登録

必要処理:

- `ROOM#<roomId> / STATE` 更新
- `CHAMPIONS / TS#...` を追加

使う API:

- `TransactWriteItems`

### AP-06. 最近の優勝ワード取得

必要処理:

- `PK=CHAMPIONS` を `Query`
- `ScanIndexForward=false`
- `Limit=5`

### AP-07. デッキ取得

必要処理:

- `PK=DECK#default` を `Query`
- `META` + `TILE#...` をまとめて読む

## 11. 更新戦略

### 11-1. revision による楽観ロック

ルーム状態は同時更新が起こりうるので、`revision` を持たせます。

#### 例

- クライアントが `revision=12` を取得
- 投票 API で更新
- サーバーは `revision = 12` を条件に更新
- 成功したら `revision = 13`
- 競合時は `CONFLICT_RETRY`

### 11-2. なぜ必要か

- 投票は複数人がほぼ同時に送る
- 再投票や待機解除も競合しうる
- ターン制でも完全に逐次にはならない

## 12. アイテムサイズ方針

ルーム状態は 1 アイテムにまとめますが、初版では 400KB 制限に十分収まる見込みです。

理由:

- 最大 4 人
- ラウンドは 3 回
- 提出は各人 3 回まで
- チャットや大量ログを持たない

将来、履歴やイベントログを大量に持つなら分割を再検討します。

## 13. TTL 方針

### 13-1. TTL 対象

- `RoomState`
- `InviteLookup`

### 13-2. TTL 目安

- 進行中ルーム: 最終更新から 24 時間
- 終了ルーム: 終了から 7 日

### 13-3. TTL 対象外

- デッキ
- 優勝履歴

## 14. バックアップと運用

- 初版では DynamoDB の標準耐久性を前提にする
- 重要なのは `デッキ` と `優勝履歴`
- 運営更新前にはデッキ JSON のバックアップを取るか、DynamoDB エクスポートを使う

## 15. 将来の拡張余地

- プレイヤー別履歴用 GSI
- ルーム一覧用 GSI
- デッキ一覧用 GSI
- ルームイベントログの別アイテム化
- WebSocket 用の接続管理テーブル追加
