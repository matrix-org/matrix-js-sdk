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

import { OlmMachine, UserId } from "@matrix-org/matrix-sdk-crypto-wasm";

import { OutgoingRequestProcessor } from "./OutgoingRequestProcessor";
import { LogSpan } from "../logger";

/**
 * KeyClaimManager: linearises calls to OlmMachine.getMissingSessions to avoid races
 *
 * We have one of these per `RustCrypto` (and hence per `MatrixClient`).
 *
 * @internal
 */
export class KeyClaimManager {
    private currentClaimPromise: Promise<void>;
    private stopped = false;

    public constructor(
        private readonly olmMachine: OlmMachine,
        private readonly outgoingRequestProcessor: OutgoingRequestProcessor,
    ) {
        this.currentClaimPromise = Promise.resolve();
    }

    /**
     * Tell the KeyClaimManager to immediately stop processing requests.
     *
     * Any further calls, and any still in the queue, will fail with an error.
     */
    public stop(): void {
        this.stopped = true;
    }

    /**
     * Given a list of users, attempt to ensure that we have Olm Sessions active with each of their devices
     *
     * If we don't have an active olm session, we will claim a one-time key and start one.
     *
     * @param userList - list of userIDs to claim
     */
    public ensureSessionsForUsers(logger: LogSpan, userList: Array<UserId>): Promise<void> {
        // The Rust-SDK requires that we only have one getMissingSessions process in flight at once. This little dance
        // ensures that, by only having one call to ensureSessionsForUsersInner active at once (and making them
        // queue up in order).
        const prom = this.currentClaimPromise
            .catch(() => {
                // any errors in the previous claim will have been reported already, so there is nothing to do here.
                // we just throw away the error and start anew.
            })
            .then(() => this.ensureSessionsForUsersInner(logger, userList));
        this.currentClaimPromise = prom;
        return prom;
    }

    private async ensureSessionsForUsersInner(logger: LogSpan, userList: Array<UserId>): Promise<void> {
        // bail out quickly if we've been stopped.
        if (this.stopped) {
            throw new Error(`Cannot ensure Olm sessions: shutting down`);
        }
        logger.info("Checking for missing Olm sessions");
        // By passing the userId array to rust we transfer ownership of the items to rust, causing
        // them to be invalidated on the JS side as soon as the method is called.
        // As we haven't created the `userList` let's clone the users, to not break the caller from re-using it.
        const claimRequest = await this.olmMachine.getMissingSessions(userList.map((u) => u.clone()));
        if (claimRequest) {
            logger.info("Making /keys/claim request");
            await this.outgoingRequestProcessor.makeOutgoingRequest(claimRequest);
        }
        logger.info("Olm sessions prepared");
    }
}
