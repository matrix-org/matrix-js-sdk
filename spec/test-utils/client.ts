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

import { MockedObject, vi } from "vitest";

import { ClientEventHandlerMap, EmittedEvents, MatrixClient } from "../../src/client";
import { TypedEventEmitter } from "../../src/models/typed-event-emitter";
import { User } from "../../src/models/user";

/**
 * Mock client with real event emitter
 * useful for testing code that listens
 * to MatrixClient events
 */
export class MockClientWithEventEmitter extends TypedEventEmitter<EmittedEvents, ClientEventHandlerMap> {
    constructor(mockProperties: Partial<Record<keyof MatrixClient, unknown>> = {}) {
        super();
        Object.assign(this, mockProperties);
    }
}

/**
 * - make a mock client
 * - cast the type to mocked(MatrixClient)
 * - spy on MatrixClientPeg.get to return the mock
 * eg
 * ```
 * const mockClient = getMockClientWithEventEmitter({
        getUserId: vi.fn().mockReturnValue(aliceId),
    });
 * ```
 */
export const getMockClientWithEventEmitter = (
    mockProperties: Partial<Record<keyof MatrixClient, unknown>>,
): MockedObject<MatrixClient> => {
    return new MockClientWithEventEmitter(mockProperties) as MockedObject<MatrixClient>;
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
export const mockClientMethodsServer = (): Partial<Record<keyof MatrixClient, unknown>> => ({
    getIdentityServerUrl: vi.fn(),
    getHomeserverUrl: vi.fn(),
    getCachedCapabilities: vi.fn().mockReturnValue({}),
    doesServerSupportUnstableFeature: vi.fn().mockResolvedValue(false),
});
