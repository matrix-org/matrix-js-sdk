#!/bin/bash -l

set -x

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 10 || exit $?
yarn install || exit $?

RC=0

function fail {
    echo $@ >&2
    RC=1
}

# don't use last time's test reports
rm -rf reports coverage || exit $?

yarn test || fail "yarn test finished with return code $?"

yarn -s lint -f checkstyle > eslint.xml ||
    fail "eslint finished with return code $?"

# delete the old tarball, if it exists
rm -f matrix-js-sdk-*.tgz

# `yarn pack` doesn't seem to run scripts, however that seems okay here as we
# just built as part of `install` above.
yarn pack ||
    fail "yarn pack finished with return code $?"

yarn gendoc || fail "JSDoc failed with code $?"

exit $RC
