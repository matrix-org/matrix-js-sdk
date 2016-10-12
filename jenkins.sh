#!/bin/bash -l

export NVM_DIR="/home/jenkins/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 0.10
npm install

RC=0

function fail {
    echo $@ >&2
    RC=1
}

npm test || fail "npm test finished with return code $?"

jshint --reporter=checkstyle -c .jshint lib spec > jshint.xml ||
    fail "jshint finished with return code $?"

gjslint --unix_mode --disable 0131,0211,0200,0222,0212 \
        --max_line_length 90 \
        -r lib/ -r spec/ > gjslint.log ||
    fail "gjslint finished with return code $?"

# delete the old tarball, if it exists
rm -f matrix-js-sdk-*.tgz

npm pack ||
    fail "npm pack finished with return code $?"

npm run gendoc || fail "JSDoc failed with code $?"

exit $RC
