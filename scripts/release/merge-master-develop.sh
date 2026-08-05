#!/bin/bash

set -ex

git checkout develop
git merge origin/master --no-commit --no-ff || true

CONFLICTS=$(git diff --name-only --diff-filter=U)

if [ -n "$CONFLICTS" ]; then
    if echo "$CONFLICTS" | grep -q 'package.json'; then
        # Merge package.json in a way where we prefer all changes from `develop`
        # except for the `version` field which we take from `master`.
        git show HEAD:package.json > package.ours.json         # develop
        git show FETCH_HEAD:package.json > package.theirs.json # master

        jq -s '(.[0].version) as $masterVersion | (reduce .[] as $item ({}; . * $item)) | .version = $masterVersion' package.theirs.json package.ours.json > package.json
        rm package.ours.json package.theirs.json
        git add package.json
    fi

    # Reset lockfile to ours (develop) to clear raw text syntax errors
    if echo "$CONFLICTS" | grep -q 'pnpm-lock.yaml'; then
        git checkout --ours pnpm-lock.yaml
    fi

    # Fallback for any other files
    git checkout --ours . 2>/dev/null || true
fi

# Rebuild lockfile based on the unified package.json
pnpm install --lockfile-only --ignore-scripts --frozen-lockfile=false

# Commit and push
git add .
git commit --no-edit
git push origin develop
