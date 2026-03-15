# おもじゃん mock API サーバー

このフォルダは、API Gateway + Lambda の前段階として使うローカル mock API です。

## 目的

- API 仕様書どおりの入口を先に作る
- フロントとバックエンドの契約を揃える
- Lambda 実装前にレスポンス形を固定する

## できること

- `GET /v1/champions/recent`
- `GET /v1/admin/decks/default`
- `GET /v1/rooms/:roomId?scenario=...`
- `POST /v1/rooms`
- `POST /v1/rooms/join`
- `POST /v1/rooms/:roomId/reconnect`
- `POST /v1/rooms/:roomId/start-player`
- `POST /v1/rooms/:roomId/start`
- `POST /v1/rooms/:roomId/rounds/:roundIndex/submit`
- `POST /v1/rooms/:roomId/rounds/:roundIndex/vote`
- `POST /v1/rooms/:roomId/rounds/:roundIndex/revote`
- `POST /v1/rooms/:roomId/rounds/:roundIndex/host-decision`
- `POST /v1/rooms/:roomId/rounds/:roundIndex/proceed`
- `POST /v1/rooms/:roomId/final-vote`
- `POST /v1/rooms/:roomId/final-revote`
- `POST /v1/rooms/:roomId/final-host-decision`
- `POST /v1/rooms/:roomId/restart`

`scenario=...` 付きの `GET /rooms/:roomId` は、引き続き debug 用の fixture 切り替えに使えます。  
一方、`POST /rooms` で作る room は in-memory の live demo として進行します。

## 起動

```bash
npm run start:mock-api
```

既定の URL:

```txt
http://127.0.0.1:8787
```

## テスト

```bash
npm run test:mock-api
```
