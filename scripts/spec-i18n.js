/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// This is a JS script to remove OS dependencies on downloading a file. Sorry.

const fs = require("fs");
const path = require("path");
const mkdirp = require("mkdirp");
const fetch = require("node-fetch");

console.log("Making res directory");
mkdirp.sync("res");

// curl -s https://github.com/matrix-org/matrix-doc/raw/master/data-definitions/sas-emoji.json > ./res/sas-emoji.json
console.log("Downloading sas-emoji.json");
const fname = path.join("res", "sas-emoji.json");
fetch("https://github.com/matrix-org/matrix-doc/raw/master/data-definitions/sas-emoji.json").then(res => {
    const stream = fs.createWriteStream(fname);
    return new Promise((resolve, reject) => {
        res.body.pipe(stream);
        res.body.on('error', err => reject(err));
        res.body.on('finish', () => resolve());
    });
}).then(() => console.log('Done with sas-emoji.json download'));
