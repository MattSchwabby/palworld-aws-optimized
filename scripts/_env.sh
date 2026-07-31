#!/usr/bin/env bash
# Shared setup, sourced by every script here.
#
# Credentials come from whichever of these you have set up, in this order:
#
#   1. AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env
#   2. AWS_PROFILE in .env
#   3. Whatever the AWS CLI already resolves on its own, which covers `aws
#      configure`, SSO, and instance roles
#
# Option 3 is the friendliest and keeps long-lived keys off your disk. Option 1
# exists for machines where some other tool has already set AWS_PROFILE or
# AWS_SESSION_TOKEN in the environment, which would otherwise silently win and send
# a deploy to the wrong account. Explicit keys in .env clear those, so they always
# take precedence.
#
# Whichever you pick, the CDK app pins every stack to the account ID in your config,
# so a mismatch fails before anything is created rather than after.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# .env is optional. Without it you are relying on the CLI's own configuration.
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
  # Explicit keys mean "use these and nothing else". A profile or a stale session
  # token inherited from the surrounding shell would otherwise take priority.
  unset AWS_PROFILE AWS_DEFAULT_PROFILE
  [ -n "${AWS_SESSION_TOKEN:-}" ] || unset AWS_SESSION_TOKEN
fi

[ -n "${AWS_REGION:-}" ] && export AWS_DEFAULT_REGION="$AWS_REGION"

# Git Bash rewrites arguments that look like absolute paths, so
# /palworld/runtime-config becomes C:/Program Files/Git/palworld/runtime-config and
# every SSM parameter name breaks.
export MSYS_NO_PATHCONV=1
# The AWS CLI is Python, and on a cp1252 Windows console a single non-ASCII
# character in a command's output aborts the call with a codec error.
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

STACK_NAME="${STACK_NAME:-PalworldServer}"

stack_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

instance_id() { stack_output InstanceId; }

# Prints the account these scripts are about to act on. Worth calling before
# anything destructive when you juggle more than one AWS account.
whoami_aws() {
  aws sts get-caller-identity --query '[Account,Arn]' --output text | tr -d '\r'
}
