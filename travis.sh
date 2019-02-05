#!/bin/bash

set -ex

npm run lint

# install Olm so that we can run the crypto tests.
npm install https://matrix.org/packages/npm/olm/olm-3.1.0-pre2.tgz

npm run test

npm run gendoc

