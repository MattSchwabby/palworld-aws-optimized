#!/usr/bin/env bash
# List the save archives currently in S3, newest last.
#
# Restoring one is deliberately manual -- see README "Restoring an older save".
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

bucket=$(stack_output BackupBucket)
echo "Bucket: ${bucket}"
echo
aws s3 ls "s3://${bucket}/saves/" --human-readable
