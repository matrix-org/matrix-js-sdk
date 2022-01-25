/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

import { IUploadKeySignaturesResponse } from "./client";

export class InvalidStoreError extends Error {
    public static TOGGLED_LAZY_LOADING = "TOGGLED_LAZY_LOADING";
    public reason: string;
    public value: boolean;

    constructor(reason: string, value: boolean) {
        const message = `Store is invalid because ${reason}, `
            + `please stop the client, delete all data and start the client again`;
        super(message);
        this.reason = reason;
        this.value = value;
    }
}

export class InvalidCryptoStoreError extends Error {
    public static TOO_NEW = "TOO_NEW";
    public reason: string;

    constructor(reason: string) {
        const message = `Crypto store is invalid because ${reason}, ` +
            `please stop the client, delete all data and start the client again`;
        super(message);
        this.reason = reason;
    }
}

export class KeySignatureUploadError extends Error {
    constructor(message: string, public value: IUploadKeySignaturesResponse) {
        super(message);
    }
}
