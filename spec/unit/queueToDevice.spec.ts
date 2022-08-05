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

import MockHttpBackend from 'matrix-mock-request';
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';

import { IHttpOpts, IndexedDBStore, MatrixEvent, MemoryStore, Room } from "../../src";
import { MatrixClient } from "../../src/client";
import { ToDeviceBatch } from '../../src/models/ToDeviceMessage';
import { logger } from '../../src/logger';
import { IStore } from '../../src/store';

const FAKE_USER = "@alice:example.org";
const FAKE_DEVICE_ID = "AAAAAAAA";
const FAKE_PAYLOAD = {
    "foo": 42,
};
const EXPECTED_BODY = {
    messages: {
        [FAKE_USER]: {
            [FAKE_DEVICE_ID]: FAKE_PAYLOAD,
        },
    },
};

const FAKE_MSG = {
    userId: FAKE_USER,
    deviceId: FAKE_DEVICE_ID,
    payload: FAKE_PAYLOAD,
};

enum StoreType {
    Memory = 'Memory',
    IndexedDB = 'IndexedDB',
}

// Jest now uses @sinonjs/fake-timers which exposes tickAsync() and a number of
// other async methods which break the event loop, letting scheduled promise
// callbacks run. Unfortunately, Jest doesn't expose these, so we have to do
// it manually (this is what sinon does under the hood). We do both in a loop
// until the thing we expect happens: hopefully this is the least flakey way
// and avoids assuming anything about the app's behaviour.
const realSetTimeout = setTimeout;
function flushPromises() {
    return new Promise(r => {
        realSetTimeout(r, 1);
    });
}

async function flushAndRunTimersUntil(cond: () => boolean) {
    while (!cond()) {
        await flushPromises();
        if (cond()) break;
        jest.advanceTimersToNextTimer();
    }
}

describe.each([
    [StoreType.Memory], [StoreType.IndexedDB],
])("queueToDevice (%s store)", function(storeType) {
    let httpBackend: MockHttpBackend;
    let client: MatrixClient;

    beforeEach(async function() {
        httpBackend = new MockHttpBackend();

        let store: IStore;
        if (storeType === StoreType.IndexedDB) {
            const idbStore = new IndexedDBStore({ indexedDB: fakeIndexedDB });
            await idbStore.startup();
            store = idbStore;
        } else {
            store = new MemoryStore();
        }

        client = new MatrixClient({
            baseUrl: "https://my.home.server",
            accessToken: "my.access.token",
            request: httpBackend.requestFn as IHttpOpts["request"],
            store,
        });
    });

    afterEach(function() {
        jest.useRealTimers();
        client.stopClient();
    });

    it("sends a to-device message", async function() {
        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).check((request) => {
            expect(request.data).toEqual(EXPECTED_BODY);
        }).respond(200, {});

        await client.queueToDevice({
            eventType: "org.example.foo",
            batch: [
                FAKE_MSG,
            ],
        });

        await httpBackend.flushAllExpected();
        // let the code handle the response to the request so we don't get
        // log output after the test has finished (apparently stopping the
        // client in aftereach is not sufficient.)
        await flushPromises();
    });

    it("retries on error", async function() {
        jest.useFakeTimers();

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).respond(500);

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).check((request) => {
            expect(request.data).toEqual(EXPECTED_BODY);
        }).respond(200, {});

        await client.queueToDevice({
            eventType: "org.example.foo",
            batch: [
                FAKE_MSG,
            ],
        });
        await flushAndRunTimersUntil(() => httpBackend.requests.length > 0);
        expect(httpBackend.flushSync(null, 1)).toEqual(1);

        await flushAndRunTimersUntil(() => httpBackend.requests.length > 0);

        expect(httpBackend.flushSync(null, 1)).toEqual(1);

        // flush, as per comment in first test
        await flushPromises();
    });

    it("stops retrying on 4xx errors", async function() {
        jest.useFakeTimers();

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).respond(400);

        await client.queueToDevice({
            eventType: "org.example.foo",
            batch: [
                FAKE_MSG,
            ],
        });
        await flushAndRunTimersUntil(() => httpBackend.requests.length > 0);
        expect(httpBackend.flushSync(null, 1)).toEqual(1);

        // Asserting that another request is never made is obviously
        // a bit tricky - we just flush the queue what should hopefully
        // be plenty of times and assert that nothing comes through.
        let tries = 0;
        await flushAndRunTimersUntil(() => ++tries === 10);

        expect(httpBackend.requests.length).toEqual(0);
    });

    it("honours ratelimiting", async function() {
        jest.useFakeTimers();

        // pick something obscure enough it's unlikley to clash with a
        // retry delay the algorithm uses anyway
        const retryDelay = 279 * 1000;

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).respond(429, {
            errcode: "M_LIMIT_EXCEEDED",
            retry_after_ms: retryDelay,
        });

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).respond(200, {});

        await client.queueToDevice({
            eventType: "org.example.foo",
            batch: [
                FAKE_MSG,
            ],
        });
        await flushAndRunTimersUntil(() => httpBackend.requests.length > 0);
        expect(httpBackend.flushSync(null, 1)).toEqual(1);
        await flushPromises();

        logger.info("Advancing clock to just before expected retry time...");

        jest.advanceTimersByTime(retryDelay - 1000);
        await flushPromises();

        expect(httpBackend.requests.length).toEqual(0);

        logger.info("Advancing clock past expected retry time...");

        jest.advanceTimersByTime(2000);
        await flushPromises();

        expect(httpBackend.flushSync(null, 1)).toEqual(1);
    });

    it("retries on retryImmediately()", async function() {
        httpBackend.when("GET", "/_matrix/client/versions").respond(200, {
            versions: ["r0.0.1"],
        });

        await Promise.all([client.startClient(), httpBackend.flush(null, 1, 20)]);

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).respond(500);

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).respond(200, {});

        await client.queueToDevice({
            eventType: "org.example.foo",
            batch: [
                FAKE_MSG,
            ],
        });
        expect(await httpBackend.flush(null, 1, 1)).toEqual(1);
        await flushPromises();

        client.retryImmediately();

        // longer timeout here to try & avoid flakiness
        expect(await httpBackend.flush(null, 1, 3000)).toEqual(1);
    });

    it("retries on when client is started", async function() {
        httpBackend.when("GET", "/_matrix/client/versions").respond(200, {
            versions: ["r0.0.1"],
        });

        await Promise.all([client.startClient(), httpBackend.flush("/_matrix/client/versions", 1, 20)]);

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).respond(500);

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).respond(200, {});

        await client.queueToDevice({
            eventType: "org.example.foo",
            batch: [
                FAKE_MSG,
            ],
        });
        expect(await httpBackend.flush(null, 1, 1)).toEqual(1);
        await flushPromises();

        client.stopClient();
        await Promise.all([client.startClient(), httpBackend.flush("/_matrix/client/versions", 1, 20)]);

        expect(await httpBackend.flush(null, 1, 20)).toEqual(1);
    });

    it("retries when a message is retried", async function() {
        httpBackend.when("GET", "/_matrix/client/versions").respond(200, {
            versions: ["r0.0.1"],
        });

        await Promise.all([client.startClient(), httpBackend.flush(null, 1, 20)]);

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).respond(500);

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).respond(200, {});

        await client.queueToDevice({
            eventType: "org.example.foo",
            batch: [
                FAKE_MSG,
            ],
        });

        expect(await httpBackend.flush(null, 1, 1)).toEqual(1);
        await flushPromises();

        const dummyEvent = new MatrixEvent({
            event_id: "!fake:example.org",
        });
        const mockRoom = {
            updatePendingEvent: jest.fn(),
        } as unknown as Room;
        client.resendEvent(dummyEvent, mockRoom);

        expect(await httpBackend.flush(null, 1, 20)).toEqual(1);
    });

    it("splits many messages into multiple HTTP requests", async function() {
        const batch: ToDeviceBatch = {
            eventType: "org.example.foo",
            batch: [],
        };

        for (let i = 0; i <= 20; ++i) {
            batch.batch.push({
                userId: `@user${i}:example.org`,
                deviceId: FAKE_DEVICE_ID,
                payload: FAKE_PAYLOAD,
            });
        }

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).check((request) => {
            expect(Object.keys(request.data.messages).length).toEqual(20);
        }).respond(200, {});

        httpBackend.when(
            "PUT", "/sendToDevice/org.example.foo/",
        ).check((request) => {
            expect(Object.keys(request.data.messages).length).toEqual(1);
        }).respond(200, {});

        await client.queueToDevice(batch);
        await httpBackend.flushAllExpected();

        // flush, as per comment in first test
        await flushPromises();
    });
});
