/**
 * @jest-environment jsdom
 */

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

// We have to use EventEmitter here to mock part of the matrix-widget-api
// project, which doesn't know about our TypeEventEmitter implementation at all
// eslint-disable-next-line no-restricted-imports
import { EventEmitter } from "events";
import { MockedObject } from "jest-mock";
import { WidgetApi, WidgetApiToWidgetAction } from "matrix-widget-api";

import { createRoomWidgetClient } from "../../src/matrix";
import { MatrixClient, ClientEvent } from "../../src/client";
import { SyncState } from "../../src/sync";
import { ICapabilities } from "../../src/embedded";
import { MatrixEvent } from "../../src/models/event";
import { DeviceInfo } from "../../src/crypto/deviceinfo";

class MockWidgetApi extends EventEmitter {
    public start = jest.fn();
    public requestCapability = jest.fn();
    public requestCapabilities = jest.fn();
    public requestCapabilityToSendState = jest.fn();
    public requestCapabilityToReceiveState = jest.fn();
    public requestCapabilityToSendToDevice = jest.fn();
    public requestCapabilityToReceiveToDevice = jest.fn();
    public sendStateEvent = jest.fn();
    public sendToDevice = jest.fn();
    public readStateEvents = jest.fn(() => []);
    public getTurnServers = jest.fn(() => []);
}

describe("RoomWidgetClient", () => {
    let widgetApi: MockedObject<WidgetApi>;
    let client: MatrixClient;

    beforeEach(() => {
        widgetApi = new MockWidgetApi() as unknown as MockedObject<WidgetApi>;
    });

    afterEach(() => {
        client.stopClient();
    });

    const makeClient = async (capabilities: ICapabilities): Promise<void> => {
        const baseUrl = "https://example.org";
        client = createRoomWidgetClient(widgetApi, capabilities, "!1:example.org", { baseUrl });
        widgetApi.emit("ready");
        await client.startClient();
    };

    describe("state events", () => {
        const event = new MatrixEvent({
            type: "org.example.foo",
            event_id: "$sfkjfsksdkfsd",
            room_id: "!1:example.org",
            sender: "@alice:example.org",
            state_key: "bar",
            content: { hello: "world" },
        }).getEffectiveEvent();

        it("sends", async () => {
            await makeClient({ sendState: [{ eventType: "org.example.foo", stateKey: "bar" }] });
            expect(widgetApi.requestCapabilityToSendState).toHaveBeenCalledWith("org.example.foo", "bar");
            await client.sendStateEvent("!1:example.org", "org.example.foo", { hello: "world" }, "bar");
            expect(widgetApi.sendStateEvent).toHaveBeenCalledWith("org.example.foo", "bar", { hello: "world" });
        });

        it("refuses to send to other rooms", async () => {
            await makeClient({ sendState: [{ eventType: "org.example.foo", stateKey: "bar" }] });
            expect(widgetApi.requestCapabilityToSendState).toHaveBeenCalledWith("org.example.foo", "bar");
            await expect(client.sendStateEvent("!2:example.org", "org.example.foo", { hello: "world" }, "bar"))
                .rejects.toBeDefined();
        });

        it("receives", async () => {
            await makeClient({ receiveState: [{ eventType: "org.example.foo", stateKey: "bar" }] });
            expect(widgetApi.requestCapabilityToReceiveState).toHaveBeenCalledWith("org.example.foo", "bar");

            const emittedEvent = new Promise<MatrixEvent>(resolve => client.once(ClientEvent.Event, resolve));
            const emittedSync = new Promise<SyncState>(resolve => client.once(ClientEvent.Sync, resolve));
            widgetApi.emit(
                `action:${WidgetApiToWidgetAction.SendEvent}`,
                new CustomEvent(`action:${WidgetApiToWidgetAction.SendEvent}`, { detail: { data: event } }),
            );

            // The client should've emitted about the received event
            expect((await emittedEvent).getEffectiveEvent()).toEqual(event);
            expect(await emittedSync).toEqual(SyncState.Syncing);
            // It should've also inserted the event into the room object
            const room = client.getRoom("!1:example.org");
            expect(room.currentState.getStateEvents("org.example.foo", "bar").getEffectiveEvent()).toEqual(event);
        });

        it("backfills", async () => {
            widgetApi.readStateEvents.mockImplementation(async (eventType, limit, stateKey) =>
                eventType === "org.example.foo" && (limit ?? Infinity) > 0 && stateKey === "bar"
                    ? [event]
                    : [],
            );

            await makeClient({ receiveState: [{ eventType: "org.example.foo", stateKey: "bar" }] });
            expect(widgetApi.requestCapabilityToReceiveState).toHaveBeenCalledWith("org.example.foo", "bar");

            const room = client.getRoom("!1:example.org");
            expect(room.currentState.getStateEvents("org.example.foo", "bar").getEffectiveEvent()).toEqual(event);
        });
    });

    describe("to-device messages", () => {
        it("sends unencrypted", async () => {
            await makeClient({ sendToDevice: ["org.example.foo"] });
            expect(widgetApi.requestCapabilityToSendToDevice).toHaveBeenCalledWith("org.example.foo");

            const contentMap = {
                "@alice:example.org": { "*": { hello: "alice!" } },
                "@bob:example.org": { bobDesktop: { hello: "bob!" } },
            };
            await client.sendToDevice("org.example.foo", contentMap);
            expect(widgetApi.sendToDevice).toHaveBeenCalledWith("org.example.foo", false, contentMap);
        });

        it("sends encrypted", async () => {
            await makeClient({ sendToDevice: ["org.example.foo"] });
            expect(widgetApi.requestCapabilityToSendToDevice).toHaveBeenCalledWith("org.example.foo");

            const payload = { type: "org.example.foo", hello: "world" };
            await client.encryptAndSendToDevices(
                [
                    { userId: "@alice:example.org", deviceInfo: new DeviceInfo("aliceWeb") },
                    { userId: "@bob:example.org", deviceInfo: new DeviceInfo("bobDesktop") },
                ],
                payload,
            );
            expect(widgetApi.sendToDevice).toHaveBeenCalledWith("org.example.foo", true, {
                "@alice:example.org": { aliceWeb: payload },
                "@bob:example.org": { bobDesktop: payload },
            });
        });

        it.todo("receives");
    });

    it.todo("gets TURN servers");
});
