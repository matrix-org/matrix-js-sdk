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

export enum InvalidCryptoStoreState {
    TooNew = "TOO_NEW",
}

export class InvalidCryptoStoreError extends Error {
    public static TOO_NEW = InvalidCryptoStoreState.TooNew;

    public constructor(public readonly reason: InvalidCryptoStoreState) {
        const message =
            `Crypto store is invalid because ${reason}, ` +
            `please stop the client, delete all data and start the client again`;
        super(message);
        this.name = "InvalidCryptoStoreError";
    }
}

export class KeySignatureUploadError extends Error {
    public constructor(
        message: string,
        public readonly value: any,
    ) {
        super(message);
    }
}

/**
 * It is invalid to call most methods once {@link MatrixClient#stopClient} has been called.
 *
 * This error will be thrown if you attempt to do so.
 *
 * {@link MatrixClient#stopClient} itself is an exception to this: it may safely be called multiple times on the same
 * instance.
 */
export class ClientStoppedError extends Error {
    public constructor() {
        super("MatrixClient has been stopped");
    }
}
