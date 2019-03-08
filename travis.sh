#!/bin/bash

set -ex

yarn lint

# install Olm so that we can run the crypto tests.
# This will add Olm as dependency, since it's currently unlisted.
# (`yarn` does not have an install dependency without adding mode.)
# TODO: Should Olm be a listed dev dependency instead, so that we can have it for testing
# and don't need to run an extra step here?
yarn add https://matrix.org/packages/npm/olm/olm-3.1.0-pre1.tgz

yarn test

yarn gendoc
