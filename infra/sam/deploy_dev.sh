#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE="${AWS_PROFILE:-omojan}"
REGION="${AWS_REGION:-ap-northeast-1}"
STACK_NAME="${STACK_NAME:-omojan-dev}"
STAGE_NAME="${STAGE_NAME:-dev}"
APP_TABLE_NAME="${APP_TABLE_NAME:-OmojanApp-dev}"
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-*}"
ADMIN_SHARED_PASSCODE="${ADMIN_SHARED_PASSCODE:-}"

if [ -z "$ADMIN_SHARED_PASSCODE" ]; then
  echo "ADMIN_SHARED_PASSCODE is required"
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" --query Account --output text)"
ARTIFACT_BUCKET_NAME="${ARTIFACT_BUCKET_NAME:-omojan-artifacts-${ACCOUNT_ID}-${REGION}}"
PACKAGED_TEMPLATE="$(mktemp "${TMPDIR:-/tmp}/omojan-packaged.XXXXXX.yaml")"

cleanup() {
  rm -f "$PACKAGED_TEMPLATE"
}
trap cleanup EXIT

echo "==> Building Lambda bundle"
bash "$ROOT_DIR/backend/lambda/api/build_bundle.sh"

echo "==> Using artifact bucket: ${ARTIFACT_BUCKET_NAME}"
if ! aws s3api head-bucket --bucket "$ARTIFACT_BUCKET_NAME" --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Creating artifact bucket"
  aws s3api create-bucket \
    --bucket "$ARTIFACT_BUCKET_NAME" \
    --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=${REGION}" \
    --profile "$PROFILE"
  aws s3api put-public-access-block \
    --bucket "$ARTIFACT_BUCKET_NAME" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
    --profile "$PROFILE" \
    --region "$REGION"
  aws s3api put-bucket-encryption \
    --bucket "$ARTIFACT_BUCKET_NAME" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' \
    --profile "$PROFILE" \
    --region "$REGION"
fi

echo "==> Packaging CloudFormation template"
aws cloudformation package \
  --template-file "$ROOT_DIR/infra/sam/template.yaml" \
  --s3-bucket "$ARTIFACT_BUCKET_NAME" \
  --output-template-file "$PACKAGED_TEMPLATE" \
  --profile "$PROFILE" \
  --region "$REGION"

echo "==> Deploying stack: ${STACK_NAME}"
aws cloudformation deploy \
  --template-file "$PACKAGED_TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    "StageName=${STAGE_NAME}" \
    "AllowedOrigin=${ALLOWED_ORIGIN}" \
    "AppTableName=${APP_TABLE_NAME}" \
    "AdminSharedPasscode=${ADMIN_SHARED_PASSCODE}" \
  --profile "$PROFILE" \
  --region "$REGION"

echo "==> Stack outputs"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --profile "$PROFILE" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table
