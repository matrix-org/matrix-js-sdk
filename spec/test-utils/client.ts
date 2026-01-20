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

import { type MockedObject } from "vitest";

import { type ClientEventHandlerMap, type EmittedEvents, type MatrixClient } from "../../src/client";
import { TypedEventEmitter } from "../../src/models/typed-event-emitter";
import { User } from "../../src/models/user";

// Cribbed from https://github.com/jestjs/jest/blob/94830794dc5dfca1b49bc435b7b031b27838a798/packages/jest-mock/src/index.ts
type FunctionLike = (...args: any) => any;
type MethodLikeKeys<T> = keyof {
    [K in keyof T as Required<T>[K] extends FunctionLike ? K : never]: T[K];
};

/**
 * Mock client with real event emitter
 * useful for testing code that listens
 * to MatrixClient events
 */
export class MockClientWithEventEmitter extends TypedEventEmitter<EmittedEvents, ClientEventHandlerMap> {
    constructor(mockProperties: Partial<Record<MethodLikeKeys<MatrixClient>, unknown>> = {}) {
        super();
        Object.assign(this, mockProperties);
    }
}

/**
 * - make a mock client
 * - cast the type to vi.mocked(MatrixClient)
 * - spy on MatrixClientPeg.get to return the mock
 * eg
 * ```
 * const mockClient = getMockClientWithEventEmitter({
        getUserId: vi.fn().mockReturnValue(aliceId),
    });
 * ```
 */
export const getMockClientWithEventEmitter = (
    mockProperties: Partial<Record<MethodLikeKeys<MatrixClient>, unknown>>,
): MockedObject<MatrixClient> => {
    const mock = vi.mocked(new MockClientWithEventEmitter(mockProperties) as unknown as MatrixClient);
    return mock;
};

/**
 * Returns basic mocked client methods related to the current user
 * ```
 * const mockClient = getMockClientWithEventEmitter({
        ...mockClientMethodsUser('@mytestuser:domain'),
    });
 * ```
 */
export const mockClientMethodsUser = (userId = "@alice:domain") => ({
    getUserId: vi.fn().mockReturnValue(userId),
    getSafeUserId: vi.fn().mockReturnValue(userId),
    getUser: vi.fn().mockReturnValue(new User(userId)),
    isGuest: vi.fn().mockReturnValue(false),
    mxcUrlToHttp: vi.fn().mockReturnValue("mock-mxcUrlToHttp"),
    credentials: { userId },
    getThreePids: vi.fn().mockResolvedValue({ threepids: [] }),
    getAccessToken: vi.fn(),
});

/**
 * Returns basic mocked client methods related to rendering events
 * ```
 * const mockClient = getMockClientWithEventEmitter({
        ...mockClientMethodsUser('@mytestuser:domain'),
    });
 * ```
 */
export const mockClientMethodsEvents = () => ({
    decryptEventIfNeeded: vi.fn(),
    getPushActionsForEvent: vi.fn(),
});

/**
 * Returns basic mocked client methods related to server support
 */
export const mockClientMethodsServer = (): Partial<Record<MethodLikeKeys<MatrixClient>, unknown>> => ({
    getIdentityServerUrl: vi.fn(),
    getHomeserverUrl: vi.fn(),
    getCachedCapabilities: vi.fn().mockReturnValue({}),
    doesServerSupportUnstableFeature: vi.fn().mockResolvedValue(false),
});
