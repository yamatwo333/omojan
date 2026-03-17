# Lambda API 雛形

このフォルダは、`おもじゃん` の本番バックエンドへ移るための Lambda 雛形です。

## 現状

- `GET /v1/health`
- `GET /v1/champions/recent`
- `GET /v1/champions/history`
- `GET /v1/admin/champions`
- `DELETE /v1/admin/champions/{championId}`
- `GET /v1/admin/decks/default`
- `PUT /v1/admin/decks/default`
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
- `POST /v1/rooms/{roomId}/final-vote`
- `POST /v1/rooms/{roomId}/final-revote`
- `POST /v1/rooms/{roomId}/final-host-decision`
- `POST /v1/rooms/{roomId}/restart`

は実装済みです。

このうちゲーム進行 API は、初版の 1 試合ループを最後まで通せる状態です。  
`GET /v1/champions/recent` と `GET /v1/champions/history` は、総合優勝が確定したワードを DynamoDB / memory に追加して返せます。  
管理用デッキ API は `X-Omojan-Admin-Passcode` ヘッダ必須です。  
`ADMIN_SHARED_PASSCODE` を設定すると、`default` デッキの取得と更新、総合優勝ワード履歴の一覧と削除が使えます。  
現在 `501 NOT_IMPLEMENTED` を返すのは、今後の拡張 API です。

補足:

- 最終投票では、自分のワードしか候補に残っていないプレイヤーを必須投票者から外します
- これにより、同じプレイヤーの勝ちワードが複数最終候補に残っても進行が止まりません

## 目的

- API Gateway + Lambda の入口を先に固定する
- ローカル mock API と本番側の責務を分ける
- lobby 系から段階的に DynamoDB 本実装へ寄せる
