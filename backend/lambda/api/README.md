# Lambda API 雛形

このフォルダは、`おもじゃん` の本番バックエンドへ移るための Lambda 雛形です。

## 現状

- `GET /v1/health`
- `GET /v1/champions/recent`
- `GET /v1/admin/decks/default`

のみ返します。

ルーム進行系 API は、今は `501 NOT_IMPLEMENTED` を返します。  
次の段階で DynamoDB 実装をここへ寄せます。

## 目的

- API Gateway + Lambda の入口を先に固定する
- ローカル mock API と本番側の責務を分ける
- DynamoDB 接続前に AWS 側のデプロイ枠を固める
