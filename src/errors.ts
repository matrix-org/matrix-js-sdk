/*
Copyright 2015-2022 The Matrix.org Foundation C.I.C.

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

export class InvalidStoreError extends Error {
    static TOGGLED_LAZY_LOADING = "TOGGLED_LAZY_LOADING";
    reason: string;
    value: unknown;

    constructor(reason: string, value: unknown) {
        const message = `Store is invalid because ${reason}, `
            + `please stop the client, delete all data and start the client again`;
        super(message);
        this.reason = reason;
        this.value = value;
    }
}

export class InvalidCryptoStoreError extends Error {
    static TOO_NEW = "TOO_NEW";
    reason: string;

    constructor(reason: string) {
        const message = `Crypto store is invalid because ${reason}, ` +
            `please stop the client, delete all data and start the client again`;
        super(message);
        this.reason = reason;
    }
}

export class KeySignatureUploadError extends Error {
    value: unknown;

    constructor(message: string, value: unknown) {
        super(message);
        this.value = value;
    }
}
