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

import MockHttpBackend from "matrix-mock-request";

import '../../olm-loader';
import { buildChannelFromCode } from "../../../src/rendezvous";
import { SimpleHttpRendezvousTransport } from '../../../src/rendezvous/transports';

describe("Rendezvous", function() {
    beforeAll(async function() {
        await global.Olm.init();
    });

    const getHttpBackend = (): MockHttpBackend => {
        const httpBackend = new MockHttpBackend();
        SimpleHttpRendezvousTransport.setFetchFn(httpBackend.fetchFn as typeof global.fetch);
        return httpBackend;
    };

    describe("buildChannelFromCode", function() {
        it("non-JSON", function() {
            expect(buildChannelFromCode("xyz", () => {})).rejects.toThrow("Invalid code");
        });

        it("invalid JSON", function() {
            expect(buildChannelFromCode(JSON.stringify({}), () => {})).rejects.toThrow("Unsupported transport");
        });

        it("invalid transport type", function() {
            expect(buildChannelFromCode(JSON.stringify({
                rendezvous: { transport: { type: "foo" } },
            }), () => {})).rejects.toThrow("Unsupported transport");
        });

        it("missing URI", function() {
            expect(buildChannelFromCode(JSON.stringify({
                rendezvous: { transport: { type: "http.v1" } },
            }), () => {})).rejects.toThrow("Invalid code");
        });

        it("invalid URI field", function() {
            expect(buildChannelFromCode(JSON.stringify({
                rendezvous: { transport: { type: "http.v1", uri: false } },
            }), () => {})).rejects.toThrow("Invalid code");
        });

        it("missing intent", function() {
            expect(buildChannelFromCode(JSON.stringify({
                rendezvous: { transport: { type: "http.v1", uri: "something" } },
            }), () => {})).rejects.toThrow("Invalid intent");
        });

        it("invalid intent", function() {
            expect(buildChannelFromCode(JSON.stringify({
                intent: 'asd',
                rendezvous: {
                    algorithm: "m.rendezvous.v1.curve25519-aes-sha256",
                    key: "",
                    transport: { type: "http.v1", uri: "something" },
                },
            }), () => {})).rejects.toThrow("Invalid intent");
        });

        it("login.reciprocate", async function() {
            const x = await buildChannelFromCode(JSON.stringify({
                intent: 'login.reciprocate',
                rendezvous: {
                    algorithm: "m.rendezvous.v1.curve25519-aes-sha256",
                    key: "",
                    transport: { type: "http.v1", uri: "something" },
                },
            }), () => {});
            expect(x.intent).toBe("login.reciprocate");
        });

        it("login.start", async function() {
            const x = await buildChannelFromCode(JSON.stringify({
                intent: 'login.start',
                rendezvous: {
                    algorithm: "m.rendezvous.v1.curve25519-aes-sha256",
                    key: "",
                    transport: { type: "http.v1", uri: "something" },
                },
            }), () => {});
            expect(x.intent).toBe("login.start");
        });

        it("parse and get", async function() {
            const httpBackend = getHttpBackend();
            const x = await buildChannelFromCode(JSON.stringify({
                intent: 'login.start',
                rendezvous: {
                    algorithm: "m.rendezvous.v1.curve25519-aes-sha256",
                    key: "",
                    transport: { type: "http.v1", uri: "https://rz.server/123456" },
                },
            }), () => {});
            expect(x.intent).toBe("login.start");

            const prom = x.channel.receive();
            httpBackend.when("GET", "https://rz.server/123456").response = {
                body: {},
                response: {
                    statusCode: 200,
                    headers: {
                        "content-type": "application/json",
                    },
                },
            };
            await httpBackend.flush('');
            expect(await prom).toStrictEqual({});
        });
    });
});
