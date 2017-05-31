/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd

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

/**
 * re-emit events raised by one EventEmitter from another
 *
 * @param {external:EventEmitter} reEmitEntity
 *     entity from which we want events to be emitted
 * @param {external:EventEmitter} emittableEntity
 *     entity from which events are currently emitted
 * @param {Array<string>} eventNames
 *     list of events to be reemitted
 */
export default function reEmit(reEmitEntity, emittableEntity, eventNames) {
    for (const eventName of eventNames) {
        // setup a listener on the entity (the Room, User, etc) for this event
        emittableEntity.on(eventName, function(...args) {
            // take the args from the listener and reuse them, adding the
            // event name to the arg list so it works with .emit()
            // Transformation Example:
            // listener on "foo" => function(a,b) { ... }
            // Re-emit on "thing" => thing.emit("foo", a, b)
            reEmitEntity.emit(eventName, ...args);
        });
    }
}
