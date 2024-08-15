#!/bin/bash

# For the published and dist versions of the package,
# we copy the `matrix_lib_main` and `matrix_lib_typings` fields to `main` and `typings` (if they exist).
# This small bit of gymnastics allows us to use the TypeScript source directly for development without
# needing to build before linting or testing.

for i in main typings browser
do
    lib_value=$(jq -r ".matrix_lib_$i" package.json)
    if [ "$lib_value" != "null" ]; then
        jq ".$i = .matrix_lib_$i" package.json > package.json.new && mv package.json.new package.json && yarn prettier --write package.json
    fi
done

# Ensure that "type": "module" is present
jq '.type = "module"' package.json > package.json.new && mv package.json.new package.json && yarn prettier --write package.json
