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

その他の更新系 API は、今は `501 NOT_IMPLEMENTED` を返します。

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
