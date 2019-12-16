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

/**
 * @module
 */

export class ReEmitter {
    constructor(target) {
        this.target = target;

        // We keep one bound event handler for each event name so we know
        // what event is arriving
        this.boundHandlers = {};
    }

    _handleEvent(eventName, ...args) {
        this.target.emit(eventName, ...args);
    }

    reEmit(source, eventNames) {
        // We include the source as the last argument for event handlers which may need it,
        // such as read receipt listeners on the client class which won't have the context
        // of the room.
        const forSource = (handler, ...args) => {
            handler(...args, source);
        };
        for (const eventName of eventNames) {
            if (this.boundHandlers[eventName] === undefined) {
                this.boundHandlers[eventName] = this._handleEvent.bind(this, eventName);
            }

            const boundHandler = forSource.bind(this, this.boundHandlers[eventName]);
            source.on(eventName, boundHandler);
        }
    }
}
