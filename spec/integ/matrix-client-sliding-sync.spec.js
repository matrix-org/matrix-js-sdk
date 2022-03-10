import { resolve } from "dns";
import { SlidingSync, SlidingSyncState, SlidingList } from "../../src/sliding-sync";
import { TestClient } from "../TestClient";

describe("SlidingSync", () => {
    let client = null;
    let httpBackend = null;
    const selfUserId = "@alice:localhost";
    const selfAccessToken = "aseukfgwef";
    const proxyBaseUrl = "http://localhost:8008";
    const syncUrl = proxyBaseUrl + "/_matrix/client/unstable/org.matrix.msc3575/sync"

    beforeEach(() => {
        const testClient = new TestClient(selfUserId, "DEVICE", selfAccessToken);
        httpBackend = testClient.httpBackend;
        client = testClient.client;
    });

    afterEach(() => {
        httpBackend.verifyNoOutstandingExpectation();
        client.stopClient();
        return httpBackend.stop();
    });

    describe("start/stop", () => {
        it("should start the sync loop upon calling start() and stop it upon calling stop()", async (done) => {
            const slidingSync = new SlidingSync(proxyBaseUrl, [], {}, client, 1);
            const fakeResp = {
                pos: "a",
                ops: [],
                counts: [],
                room_subscriptions: {},
            };
            httpBackend.when("POST", syncUrl).respond(200, fakeResp);
            let deliver = callbackPromise(500, "lifecycle callback was not called");
            slidingSync.addLifecycleListener(deliver.callback);
            slidingSync.start();
            await httpBackend.flush(syncUrl, 1);
            let lifecycleData = await deliver.promise;
            expect(lifecycleData[0]).toEqual(SlidingSyncState.RequestFinished);
            expect(lifecycleData[1]).toEqual(fakeResp);
            expect(lifecycleData[2]).toBeFalsy();
            slidingSync.stop();
            done();
        });
    });

    describe("room subscriptions", () => {
        const roomId = "!foo:bar";
        const roomSubInfo = {
            timeline_limit: 1,
            required_state: [
                ["m.room.name", ""],
            ]
        };
        const wantRoomData = {
            name: "foo bar",
            required_state: [],
            timeline: [],
        };

        it("should be able to subscribe/unsubscribe to a room", async (done) => {    
            // add the subscription
            const slidingSync = new SlidingSync(proxyBaseUrl, [], roomSubInfo, client, 1);
            slidingSync.roomSubscriptions.add(roomId);
            const fakeResp = {
                pos: "a",
                ops: [],
                counts: [],
                room_subscriptions: {
                    [roomId]: wantRoomData
                },
            };
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log(body);
                expect(body.room_subscriptions).toBeTruthy();
                expect(body.room_subscriptions[roomId]).toEqual(roomSubInfo);
            }).respond(200, fakeResp);
            let deliver = callbackPromise(500, "room callback was not called");
            slidingSync.addRoomDataListener(deliver.callback);
            slidingSync.start();
            await httpBackend.flush(syncUrl, 1);
            let roomData = await deliver.promise;
            expect(roomData[0]).toEqual(roomId);
            expect(roomData[1]).toEqual(wantRoomData);

            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log("2", body);
                expect(body.room_subscriptions).toBeFalsy();
                expect(body.unsubscribe_rooms).toEqual([roomId]);
            }).respond(200, fakeResp);
        
            deliver = callbackPromise(500, "lifecycle callback was not called");
            slidingSync.addLifecycleListener(deliver.callback);
        
            // remove the subscription
            slidingSync.roomSubscriptions.delete(roomId);
        
            // kick the connection to resend the unsub
            slidingSync.resend();
            await httpBackend.flush(syncUrl, 2); // flush 2, the one made before the req change and the req change
            await deliver.promise;
            slidingSync.stop();
            done();
        });
    });

    describe("lists", () => {
        it("should be possible to subscribe to a list", async (done) => {
            // request first 3 rooms
            let listReq = {
                ranges:  [[0,2]],
                sort: ["by_name"],
                timeline_limit: 1,
                required_state: [
                    ["m.room.topic", ""],
                ],
                filters: {
                    is_dm: true,
                },
            };
            let list = new SlidingList(listReq, [[0,5]]);
            const slidingSync = new SlidingSync(proxyBaseUrl, [list], {}, client, 1);
            const roomA = "!a:localhost";
            const roomB = "!b:localhost";
            const roomC = "!c:localhost";
            const rooms = [
                {
                    room_id: roomA,
                    name: "A"
                },
                {
                    room_id: roomB,
                    name: "B"
                },
                {
                    room_id: roomC,
                    name: "C"
                },
            ]
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log(body);
                expect(body.lists).toBeTruthy();
                expect(body.lists[0]).toEqual(listReq);
            }).respond(200, {
                pos: "a",
                ops: [{
                    op: "SYNC",
                    list: 0,
                    range: [0,2],
                    rooms: rooms,
                }],
                counts: [500],
            });
            let listenerData = {};
            slidingSync.addRoomDataListener((roomId, roomData) => {
                expect(listenerData[roomId]).toBeFalsy();
                listenerData[roomId] = roomData;
            });
            let responseProcessed = new Promise((resolve) => {
                slidingSync.addLifecycleListener((state)=> {
                    if (state === SlidingSyncState.Complete) {
                        resolve();
                    }
                });
            });
            slidingSync.start();
            await httpBackend.flush(syncUrl, 1);
            await responseProcessed;

            expect(listenerData[roomA]).toEqual(rooms[0]);
            expect(listenerData[roomB]).toEqual(rooms[1]);
            expect(listenerData[roomC]).toEqual(rooms[2]);
            slidingSync.stop();
            done();
        });
    });
});

function timeout(delayMs, reason) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(`timeout: ${delayMs}ms - ${reason}`);
        }, delayMs);
    });
}

// resolves the promise when the callback is invoked. Rejects the promise after the timeout with reason.
function callbackPromise(timeoutMs, reason) {
    let r;
    const cb = (...rest) => {
        r(rest);
    };
    const p = new Promise((resolve) => {
        r = resolve;
    });
    return {
        promise: Promise.race([p, timeout(timeoutMs, reason)]),
        callback: cb,
    }
}