#!/bin/bash

set -ex

npm run lint

# install Olm so that we can run the crypto tests.
npm install https://matrix.org/packages/npm/olm/olm-2.3.0.tgz

npm run test

npm run gendoc

