# SAM / CloudFormation 雛形

このフォルダは、`おもじゃん` のバックエンドを AWS に載せるための最小雛形です。

## 含まれるもの

- `API Gateway (HTTP API)`
- `Lambda`
- `DynamoDB`

## 現状

- Lambda は `backend/lambda/api/handler.js` を使います
- room 作成、参加、開始、提出、投票、再投票、ホスト裁定、最終投票、再開まで実装済みです
- DynamoDB は 1 テーブル構成で `ROOM / INVITE` を保持します

## テンプレート検証

```bash
aws cloudformation validate-template \
  --template-body file://infra/sam/template.yaml \
  --profile omojan \
  --region ap-northeast-1
```

## dev デプロイ

最小構成の dev 環境は、同梱のスクリプトでそのまま作れます。初回は artifact 用 S3 bucket も自動で作ります。

```bash
bash infra/sam/deploy_dev.sh
```

主な既定値:

- profile: `omojan`
- region: `ap-northeast-1`
- stack: `omojan-dev`
- table: `OmojanApp-dev`
- allowed origin: `*`

必要なら環境変数で上書きできます。

```bash
STACK_NAME=omojan-stg APP_TABLE_NAME=OmojanApp-stg bash infra/sam/deploy_dev.sh
```

デプロイ後は `HttpApiBaseUrl` が出るので、phase プロトタイプは次のように開けます。

```txt
https://main.dr94wxwisw55z.amplifyapp.com/omojan_phase_prototype.html?data=auto&apiBaseUrl=<HttpApiBaseUrl>/v1
```

現在の dev API:

```txt
https://nglzfg3co5.execute-api.ap-northeast-1.amazonaws.com/dev/v1
```
