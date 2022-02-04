/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import { MatrixClient } from "./client";
import { IEvent, MatrixEvent } from "./models/event";

export type EventMapper = (obj: Partial<IEvent>) => MatrixEvent;

export interface MapperOpts {
    preventReEmit?: boolean;
    decrypt?: boolean;
}

export function eventMapperFor(client: MatrixClient, options: MapperOpts): EventMapper {
    const preventReEmit = Boolean(options.preventReEmit);
    const decrypt = options.decrypt !== false;

    function mapper(plainOldJsObject: Partial<IEvent>) {
        const room = client.getRoom(plainOldJsObject.room_id);
        let event: MatrixEvent;

        // If the event is already known to the room, let's re-use the model
        // rather than creating a duplicate
        if (room) {
            event = room.findEventById(plainOldJsObject.event_id);
        }

        // If no event is found or if the event found was only local we can
        // safely create a new model
        if (!event || event.status) {
            event = new MatrixEvent(plainOldJsObject);
        }

        if (event.isEncrypted()) {
            if (!preventReEmit) {
                client.reEmitter.reEmit(event, [
                    "Event.decrypted",
                ]);
            }
            if (decrypt) {
                client.decryptEventIfNeeded(event);
            }
        }
        if (!preventReEmit) {
            client.reEmitter.reEmit(event, ["Event.replaced", "Event.visibilityChange"]);
        }
        return event;
    }

    return mapper;
}
