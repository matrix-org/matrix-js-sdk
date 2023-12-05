/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import * as RustSdkCryptoJs from "@matrix-org/matrix-sdk-crypto-wasm";
import { Mocked } from "jest-mock";

import { isVerificationEvent, RustVerificationRequest } from "../../../src/rust-crypto/verification";
import { OutgoingRequestProcessor } from "../../../src/rust-crypto/OutgoingRequestProcessor";
import { EventType, MatrixEvent, MsgType } from "../../../src";

describe("VerificationRequest", () => {
    describe("pending", () => {
        let request: RustVerificationRequest;
        let mockedInner: Mocked<RustSdkCryptoJs.VerificationRequest>;

        beforeEach(() => {
            mockedInner = makeMockedInner();
            request = makeTestRequest(mockedInner);
        });

        it("returns true for a created request", () => {
            expect(request.pending).toBe(true);
        });

        it("returns false for passive requests", () => {
            mockedInner.isPassive.mockReturnValue(true);
            expect(request.pending).toBe(false);
        });

        it("returns false for completed requests", () => {
            mockedInner.phase.mockReturnValue(RustSdkCryptoJs.VerificationRequestPhase.Done);
            expect(request.pending).toBe(false);
        });

        it("returns false for cancelled requests", () => {
            mockedInner.phase.mockReturnValue(RustSdkCryptoJs.VerificationRequestPhase.Cancelled);
            expect(request.pending).toBe(false);
        });
    });

    describe("timeout", () => {
        it("passes through the result", () => {
            const mockedInner = makeMockedInner();
            const request = makeTestRequest(mockedInner);
            mockedInner.timeRemainingMillis.mockReturnValue(10_000);
            expect(request.timeout).toEqual(10_000);
        });
    });

    describe("startVerification", () => {
        let request: RustVerificationRequest;
        let machine: Mocked<RustSdkCryptoJs.OlmMachine>;
        let inner: Mocked<RustSdkCryptoJs.VerificationRequest>;

        beforeEach(() => {
            inner = makeMockedInner();
            machine = { getDevice: jest.fn() } as unknown as Mocked<RustSdkCryptoJs.OlmMachine>;
            request = makeTestRequest(inner, machine);
        });

        it("does not permit methods other than SAS", async () => {
            await expect(request.startVerification("m.reciprocate.v1")).rejects.toThrow(
                "Unsupported verification method",
            );
        });

        it("raises an error if the other device is unknown", async () => {
            await expect(request.startVerification("m.sas.v1")).rejects.toThrow(
                "startVerification(): other device is unknown",
            );
        });

        it("raises an error if starting verification does not produce a verifier", async () => {
            jest.spyOn(inner, "otherDeviceId", "get").mockReturnValue(new RustSdkCryptoJs.DeviceId("other_device"));
            machine.getDevice.mockResolvedValue({} as RustSdkCryptoJs.Device);
            await expect(request.startVerification("m.sas.v1")).rejects.toThrow(
                "Still no verifier after startSas() call",
            );
        });
    });
});

describe("isVerificationEvent", () => {
    it.each([
        [EventType.KeyVerificationCancel],
        [EventType.KeyVerificationDone],
        [EventType.KeyVerificationMac],
        [EventType.KeyVerificationStart],
        [EventType.KeyVerificationKey],
        [EventType.KeyVerificationReady],
        [EventType.KeyVerificationAccept],
    ])("should return true with %s event", (eventType) => {
        const event = new MatrixEvent({
            type: eventType,
        });
        expect(isVerificationEvent(event)).toBe(true);
    });

    it("should return true with EventType.RoomMessage and MsgType.KeyVerificationRequest", () => {
        const event = new MatrixEvent({
            type: EventType.RoomMessage,
            content: {
                msgtype: MsgType.KeyVerificationRequest,
            },
        });
        expect(isVerificationEvent(event)).toBe(true);
    });

    it("should return false with a non verification event", () => {
        const event = new MatrixEvent({
            type: EventType.RoomName,
        });
        expect(isVerificationEvent(event)).toBe(false);
    });
});

/** build a RustVerificationRequest with default parameters */
function makeTestRequest(
    inner?: RustSdkCryptoJs.VerificationRequest,
    olmMachine?: RustSdkCryptoJs.OlmMachine,
    outgoingRequestProcessor?: OutgoingRequestProcessor,
): RustVerificationRequest {
    inner ??= makeMockedInner();
    olmMachine ??= {} as RustSdkCryptoJs.OlmMachine;
    outgoingRequestProcessor ??= {} as OutgoingRequestProcessor;
    return new RustVerificationRequest(olmMachine, inner, outgoingRequestProcessor, []);
}

/** Mock up a rust-side VerificationRequest */
function makeMockedInner(): Mocked<RustSdkCryptoJs.VerificationRequest> {
    return {
        registerChangesCallback: jest.fn(),
        startSas: jest.fn(),
        phase: jest.fn().mockReturnValue(RustSdkCryptoJs.VerificationRequestPhase.Created),
        isPassive: jest.fn().mockReturnValue(false),
        timeRemainingMillis: jest.fn(),
        get otherDeviceId() {
            return undefined;
        },
    } as unknown as Mocked<RustSdkCryptoJs.VerificationRequest>;
}
