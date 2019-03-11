#!/bin/bash

set -ex

yarn lint

yarn test

yarn gendoc
