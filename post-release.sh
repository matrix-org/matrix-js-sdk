#!/bin/bash
#
# Script to perform a post-release steps of matrix-js-sdk.
#
# Requires:
#   jq; install from your distribution's package manager (https://stedolan.github.io/jq/)

set -e

jq --version > /dev/null || (echo "jq is required: please install it"; kill $$)

if [ "$(git branch -lr | grep origin/develop -c)" -ge 1 ]; then
    "$(dirname "$0")/scripts/release/post-merge-master.sh"
    git push origin develop
fi
