#!/bin/bash -l

set -x

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 10 || exit $?
npm install || exit $?

RC=0

function fail {
    echo $@ >&2
    RC=1
}

# don't use last time's test reports
rm -rf reports coverage || exit $?

npm test || fail "npm test finished with return code $?"

npm run -s lint -- -f checkstyle > eslint.xml ||
    fail "eslint finished with return code $?"

# delete the old tarball, if it exists
rm -f matrix-js-sdk-*.tgz

npm pack ||
    fail "npm pack finished with return code $?"

npm run gendoc || fail "JSDoc failed with code $?"

exit $RC
