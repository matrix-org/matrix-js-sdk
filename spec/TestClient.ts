/*
Copyright 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2018-2019 New Vector Ltd

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

// load olm before the sdk if possible
import './olm-loader';

import MockHttpBackend from 'matrix-mock-request';

import { LocalStorageCryptoStore } from '../src/crypto/store/localStorage-crypto-store';
import { logger } from '../src/logger';
import { syncPromise } from "./test-utils/test-utils";
import { createClient } from "../src/matrix";
import { ICreateClientOpts, IDownloadKeyResult, MatrixClient, PendingEventOrdering } from "../src/client";
import { MockStorageApi } from "./MockStorageApi";
import { encodeUri } from "../src/utils";
import { IDeviceKeys, IOneTimeKey } from "../src/crypto/dehydration";
import { IKeyBackupSession } from "../src/crypto/keybackup";
import { IHttpOpts } from "../src/http-api";
import { IKeysUploadResponse, IUploadKeysRequest } from '../src/client';

/**
 * Wrapper for a MockStorageApi, MockHttpBackend and MatrixClient
 */
export class TestClient {
    public readonly httpBackend: MockHttpBackend;
    public readonly client: MatrixClient;
    private deviceKeys: IDeviceKeys;
    private oneTimeKeys: Record<string, IOneTimeKey>;

    constructor(
        public readonly userId?: string,
        public readonly deviceId?: string,
        accessToken?: string,
        sessionStoreBackend?: Storage,
        options?: Partial<ICreateClientOpts>,
    ) {
        if (sessionStoreBackend === undefined) {
            sessionStoreBackend = new MockStorageApi();
        }

        this.httpBackend = new MockHttpBackend();

        const fullOptions: ICreateClientOpts = {
            baseUrl: "http://" + userId + ".test.server",
            userId: userId,
            accessToken: accessToken,
            deviceId: deviceId,
            request: this.httpBackend.requestFn as IHttpOpts["request"],
            ...options,
        };
        if (!fullOptions.cryptoStore) {
            // expose this so the tests can get to it
            fullOptions.cryptoStore = new LocalStorageCryptoStore(sessionStoreBackend);
        }
        this.client = createClient(fullOptions);

        this.deviceKeys = null;
        this.oneTimeKeys = {};
    }

    public toString(): string {
        return 'TestClient[' + this.userId + ']';
    }

    /**
     * start the client, and wait for it to initialise.
     */
    public start(): Promise<void> {
        logger.log(this + ': starting');
        this.httpBackend.when("GET", "/versions").respond(200, {});
        this.httpBackend.when("GET", "/pushrules").respond(200, {});
        this.httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });
        this.expectDeviceKeyUpload();

        // we let the client do a very basic initial sync, which it needs before
        // it will upload one-time keys.
        this.httpBackend.when("GET", "/sync").respond(200, { next_batch: 1 });

        this.client.startClient({
            // set this so that we can get hold of failed events
            pendingEventOrdering: PendingEventOrdering.Detached,
        });

        return Promise.all([
            this.httpBackend.flushAllExpected(),
            syncPromise(this.client),
        ]).then(() => {
            logger.log(this + ': started');
        });
    }

    /**
     * stop the client
     * @return {Promise} Resolves once the mock http backend has finished all pending flushes
     */
    public async stop(): Promise<void> {
        this.client.stopClient();
        await this.httpBackend.stop();
    }

    /**
     * Set up expectations that the client will upload device keys.
     */
    public expectDeviceKeyUpload() {
        this.httpBackend.when("POST", "/keys/upload")
            .respond<IKeysUploadResponse, IUploadKeysRequest>(200, (_path, content) => {
                expect(content.one_time_keys).toBe(undefined);
                expect(content.device_keys).toBeTruthy();

                logger.log(this + ': received device keys');
                // we expect this to happen before any one-time keys are uploaded.
                expect(Object.keys(this.oneTimeKeys).length).toEqual(0);

                this.deviceKeys = content.device_keys;
                return { one_time_key_counts: { signed_curve25519: 0 } };
            });
    }

    /**
     * If one-time keys have already been uploaded, return them. Otherwise,
     * set up an expectation that the keys will be uploaded, and wait for
     * that to happen.
     *
     * @returns {Promise} for the one-time keys
     */
    public awaitOneTimeKeyUpload(): Promise<Record<string, IOneTimeKey>> {
        if (Object.keys(this.oneTimeKeys).length != 0) {
            // already got one-time keys
            return Promise.resolve(this.oneTimeKeys);
        }

        this.httpBackend.when("POST", "/keys/upload")
            .respond<IKeysUploadResponse, IUploadKeysRequest>(200, (_path, content: IUploadKeysRequest) => {
                expect(content.device_keys).toBe(undefined);
                expect(content.one_time_keys).toBe(undefined);
                return { one_time_key_counts: {
                    signed_curve25519: Object.keys(this.oneTimeKeys).length,
                } };
            });

        this.httpBackend.when("POST", "/keys/upload")
            .respond<IKeysUploadResponse, IUploadKeysRequest>(200, (_path, content: IUploadKeysRequest) => {
                expect(content.device_keys).toBe(undefined);
                expect(content.one_time_keys).toBeTruthy();
                expect(content.one_time_keys).not.toEqual({});
                logger.log('%s: received %i one-time keys', this,
                    Object.keys(content.one_time_keys).length);
                this.oneTimeKeys = content.one_time_keys;
                return { one_time_key_counts: {
                    signed_curve25519: Object.keys(this.oneTimeKeys).length,
                } };
            });

        // this can take ages
        return this.httpBackend.flush('/keys/upload', 2, 1000).then((flushed) => {
            expect(flushed).toEqual(2);
            return this.oneTimeKeys;
        });
    }

    /**
     * Set up expectations that the client will query device keys.
     *
     * We check that the query contains each of the users in `response`.
     *
     * @param {Object} response   response to the query.
     */
    public expectKeyQuery(response: IDownloadKeyResult) {
        this.httpBackend.when('POST', '/keys/query').respond<IDownloadKeyResult>(
            200, (_path, content) => {
                Object.keys(response.device_keys).forEach((userId) => {
                    expect(content.device_keys[userId]).toEqual([]);
                });
                return response;
            });
    }

    /**
     * Set up expectations that the client will query key backups for a particular session
     */
    public expectKeyBackupQuery(roomId: string, sessionId: string, status: number, response: IKeyBackupSession) {
        this.httpBackend.when('GET', encodeUri("/room_keys/keys/$roomId/$sessionId", {
            $roomId: roomId,
            $sessionId: sessionId,
        })).respond(status, response);
    }

    /**
     * get the uploaded curve25519 device key
     *
     * @return {string} base64 device key
     */
    public getDeviceKey(): string {
        const keyId = 'curve25519:' + this.deviceId;
        return this.deviceKeys.keys[keyId];
    }

    /**
     * get the uploaded ed25519 device key
     *
     * @return {string} base64 device key
     */
    public getSigningKey(): string {
        const keyId = 'ed25519:' + this.deviceId;
        return this.deviceKeys.keys[keyId];
    }

    /**
     * flush a single /sync request, and wait for the syncing event
     */
    public flushSync(): Promise<void> {
        logger.log(`${this}: flushSync`);
        return Promise.all([
            this.httpBackend.flush('/sync', 1),
            syncPromise(this.client),
        ]).then(() => {
            logger.log(`${this}: flushSync completed`);
        });
    }

    public isFallbackICEServerAllowed(): boolean {
        return true;
    }
}
