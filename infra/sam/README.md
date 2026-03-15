# SAM / CloudFormation 雛形

このフォルダは、`おもじゃん` のバックエンドを AWS に載せるための最小雛形です。

## 含まれるもの

- `API Gateway (HTTP API)`
- `Lambda`
- `DynamoDB`

## 現状

- Lambda は `backend/lambda/api/handler.js` を使います
- `health / champions / deck` だけ返せます
- ルーム進行系 API は、次の段階で DynamoDB 実装へ差し替えます

## テンプレート検証

```bash
aws cloudformation validate-template \
  --template-body file://infra/sam/template.yaml \
  --profile omojan \
  --region ap-northeast-1
```

## デプロイの基本形

事前にデプロイ用 S3 bucket を 1 つ用意します。

```bash
aws cloudformation package \
  --template-file infra/sam/template.yaml \
  --s3-bucket <artifact-bucket-name> \
  --output-template-file infra/sam/packaged.yaml \
  --profile omojan \
  --region ap-northeast-1
```

```bash
aws cloudformation deploy \
  --template-file infra/sam/packaged.yaml \
  --stack-name omojan-dev \
  --capabilities CAPABILITY_IAM \
  --profile omojan \
  --region ap-northeast-1
```
