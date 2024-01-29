import { logger } from "./logger";
import { MatrixEvent } from "./matrix";

/*
Copyright 2021-2024 The Matrix.org Foundation C.I.C.

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
let serverToLocalTimeOffset: number | undefined = undefined;

/**
 * This method should only be used after computing the server-client time offset
 * using: tryComputeTimeSyncWithEvent or computeTimeSyncWithRequest.
 */
const getServerToLocalTimeOffset = (): number => {
    if (!serverToLocalTimeOffset) {
        logger.warn("Server time offset not computed yet, using 0");
        serverToLocalTimeOffset = 0;
    }
    if (!serverToLocalTimeOffset) throw new Error("Failed to compute time sync");

    return serverToLocalTimeOffset;
};
/**
 * This uses a matrix event with an age property to compute the time offset.
 * This also works when the event was not just now received from the homeserver
 * because the event tracks the time since it has been received via the localTimestamp.
 * @param event - The matrix event used to compute the time offset.
 * @returns true if the time offset computation was successful, false otherwise
 */
export const tryComputeTimeSyncWithEvent = (event: MatrixEvent): boolean => {
    const serverTimeNow = event.getTs() + event.getLocalAge();
    serverToLocalTimeOffset = serverTimeNow - Date.now();

    return true;
};

/**
 * Computes the time offset between the server and the local machine by sending
 * a http request to the server.
 * (UNIMPLEMNENTED)
 * @returns true if the time offset computation was successful, false otherwise
 */
export const computeTimeSyncWithRequest = async (): Promise<boolean> => {
    // TODO: fetch time now from server (temporarily use offset of 0)
    serverToLocalTimeOffset = 0;
    return true;
    // await ...
};

/**
 * This method should only be used after computing the server-client time offset
 * using: tryComputeTimeSyncWithEvent or computeTimeSyncWithRequest.
 */
export const getServerTimeNow = (): number => {
    return localTsToServerTs(Date.now());
};

/**
 * This method should only be used after computing the server-client time offset
 * using: tryComputeTimeSyncWithEvent or computeTimeSyncWithRequest.
 */
export const serverTsToLocalTs = (serverTs: number): number => {
    return serverTs + getServerToLocalTimeOffset();
};

/**
 * This method should only be used after computing the server-client time offset
 * using: tryComputeTimeSyncWithEvent or computeTimeSyncWithRequest.
 */
export const localTsToServerTs = (localTs: number): number => {
    return localTs - getServerToLocalTimeOffset();
};
