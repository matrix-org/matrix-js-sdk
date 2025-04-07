/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import type { CallMembership } from "./CallMembership.ts";
import type { Focus } from "./focus.ts";
import type { Status } from "./types.ts";

export enum MembershipManagerEvent {
    StatusChanged = "StatusChanged",
}

export type MembershipManagerEventHandlerMap = {
    [MembershipManagerEvent.StatusChanged]: (prefStatus: Status, newStatus: Status) => void;
};

/**
 * This interface defines what a MembershipManager uses and exposes.
 * This interface is what we use to write tests and allows changing the actual implementation
 * without breaking tests because of some internal method renaming.
 *
 * @internal
 */
export interface IMembershipManager {
    /**
     * If we are trying to join, or have successfully joined the session.
     * It does not reflect if the room state is already configured to represent us being joined.
     * It only means that the Manager should be trying to connect or to disconnect running.
     * The Manager is still running right after isJoined becomes false to send the disconnect events.
     * @returns true if we intend to be participating in the MatrixRTC session
     * @deprecated This name is confusing and replaced by `isActivated()`. (Returns the same as `isActivated()`)
     */
    isJoined(): boolean;
    /**
     * If the manager is activated. This means it tries to do its job to join the call, resend state events...
     * It does not imply that the room state is already configured to represent being joined.
     * It means that the Manager tries to connect or is connected. ("the manager is still active")
     * Once `leave()` is called the manager is not activated anymore but still running until `leave()` resolves.
     * @returns `true` if we intend to be participating in the MatrixRTC session
     */
    isActivated(): boolean;
    /**
     * Get the actual connection status of the manager.
     */
    get status(): Status;
    /**
     * The current status while the manager is activated
     */
    /**
     * Start sending all necessary events to make this user participate in the RTC session.
     * @param fociPreferred the list of preferred foci to use in the joined RTC membership event.
     * @param fociActive the active focus to use in the joined RTC membership event.
     * @throws can throw if it exceeds a configured maximum retry.
     */
    join(fociPreferred: Focus[], fociActive?: Focus, onError?: (error: unknown) => void): void;
    /**
     * Send all necessary events to make this user leave the RTC session.
     * @param timeout the maximum duration in ms until the promise is forced to resolve.
     * @returns It resolves with true in case the leave was sent successfully.
     * It resolves with false in case we hit the timeout before sending successfully.
     */
    leave(timeout?: number): Promise<boolean>;
    /**
     * Call this if the MatrixRTC session members have changed.
     */
    onRTCSessionMemberUpdate(memberships: CallMembership[]): Promise<void>;
    /**
     * The used active focus in the currently joined session.
     * @returns the used active focus in the currently joined session or undefined if not joined.
     */
    getActiveFocus(): Focus | undefined;

    // TypedEventEmitter methods:
    on(event: MembershipManagerEvent.StatusChanged, listener: (oldStatus: Status, newStatus: Status) => void): this;
    off(event: MembershipManagerEvent.StatusChanged, listener: (oldStatus: Status, newStatus: Status) => void): this;
}
