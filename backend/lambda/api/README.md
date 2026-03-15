# Lambda API 雛形

このフォルダは、`おもじゃん` の本番バックエンドへ移るための Lambda 雛形です。

## 現状

- `GET /v1/health`
- `GET /v1/champions/recent`
- `GET /v1/admin/decks/default`
- `POST /v1/rooms`
- `POST /v1/rooms/join`
- `GET /v1/rooms/{roomId}`
- `POST /v1/rooms/{roomId}/reconnect`
- `POST /v1/rooms/{roomId}/start-player`
- `POST /v1/rooms/{roomId}/start`
- `POST /v1/rooms/{roomId}/rounds/{roundIndex}/submit`
- `POST /v1/rooms/{roomId}/rounds/{roundIndex}/vote`
- `POST /v1/rooms/{roomId}/rounds/{roundIndex}/revote`
- `POST /v1/rooms/{roomId}/rounds/{roundIndex}/host-decision`
- `POST /v1/rooms/{roomId}/rounds/{roundIndex}/proceed`

は実装済みです。

このうち room 系は DynamoDB を使う本実装です。  
一方で、最終投票まわりの API はまだ `501 NOT_IMPLEMENTED` を返します。

## 目的

- API Gateway + Lambda の入口を先に固定する
- ローカル mock API と本番側の責務を分ける
- lobby 系から段階的に DynamoDB 本実装へ寄せる
