/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2017 New Vector Ltd

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

import { EventEmitter } from "events";

export class ReEmitter {
    private target: EventEmitter;

    constructor(target: EventEmitter) {
        this.target = target;
    }

    reEmit(source: EventEmitter, eventNames: string[]) {
        for (const eventName of eventNames) {
            // We include the source as the last argument for event handlers which may need it,
            // such as read receipt listeners on the client class which won't have the context
            // of the room.
            const forSource = (...args) => {
                this.target.emit(eventName, ...args, source);
            };
            source.on(eventName, forSource);
        }
    }
}
