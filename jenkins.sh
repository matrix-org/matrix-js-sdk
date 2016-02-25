#!/bin/bash -l
export NVM_DIR="/home/jenkins/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 0.10
npm install
npm test
jshint --reporter=checkstyle -c .jshint lib spec > jshint.xml || echo "jshint finished with return code $?"
gjslint --unix_mode --disable 0131,0211,0200,0222,0212 --max_line_length 90 -r lib/ -r spec/ > gjslint.log || echo "gjslint finished with return code $?"
