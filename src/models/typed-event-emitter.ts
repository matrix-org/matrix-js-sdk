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

// eslint-disable-next-line no-restricted-imports
import { EventEmitter } from "events";

export enum EventEmitterEvents {
    NewListener = "newListener",
    RemoveListener = "removeListener",
    Error = "error",
}

type AnyListener = (...args: any) => any;
export type ListenerMap<E extends string> = { [eventName in E]: AnyListener };
type EventEmitterEventListener = (eventName: string, listener: AnyListener) => void;
type EventEmitterErrorListener = (error: Error) => void;

export type Listener<
    E extends string,
    A extends ListenerMap<E>,
    T extends E | EventEmitterEvents,
> = T extends E ? A[T]
    : T extends EventEmitterEvents ? EventEmitterErrorListener
    : EventEmitterEventListener;

/**
 * Typed Event Emitter class which can act as a Base Model for all our model
 * and communication events.
 * This makes it much easier for us to distinguish between events, as we now need
 * to properly type this, so that our events are not stringly-based and prone
 * to silly typos.
 */
export class TypedEventEmitter<
    Events extends string,
    Arguments extends ListenerMap<Events>,
    SuperclassArguments extends ListenerMap<any> = Arguments,
> extends EventEmitter {
    public addListener<T extends Events | EventEmitterEvents>(
        event: T,
        listener: Listener<Events, Arguments, T>,
    ): this {
        return super.addListener(event, listener);
    }

    public emit<T extends Events>(event: T, ...args: Parameters<SuperclassArguments[T]>): boolean;
    public emit<T extends Events>(event: T, ...args: Parameters<Arguments[T]>): boolean;
    public emit<T extends Events>(event: T, ...args: any[]): boolean {
        return super.emit(event, ...args);
    }

    public eventNames(): (Events | EventEmitterEvents)[] {
        return super.eventNames() as Array<Events | EventEmitterEvents>;
    }

    public listenerCount(event: Events | EventEmitterEvents): number {
        return super.listenerCount(event);
    }

    public listeners(event: Events | EventEmitterEvents): Function[] {
        return super.listeners(event);
    }

    public off<T extends Events | EventEmitterEvents>(
        event: T,
        listener: Listener<Events, Arguments, T>,
    ): this {
        return super.off(event, listener);
    }

    public on<T extends Events | EventEmitterEvents>(
        event: T,
        listener: Listener<Events, Arguments, T>,
    ): this {
        return super.on(event, listener);
    }

    public once<T extends Events | EventEmitterEvents>(
        event: T,
        listener: Listener<Events, Arguments, T>,
    ): this {
        return super.once(event, listener);
    }

    public prependListener<T extends Events | EventEmitterEvents>(
        event: T,
        listener: Listener<Events, Arguments, T>,
    ): this {
        return super.prependListener(event, listener);
    }

    public prependOnceListener<T extends Events | EventEmitterEvents>(
        event: T,
        listener: Listener<Events, Arguments, T>,
    ): this {
        return super.prependOnceListener(event, listener);
    }

    public removeAllListeners(event?: Events | EventEmitterEvents): this {
        return super.removeAllListeners(event);
    }

    public removeListener<T extends Events | EventEmitterEvents>(
        event: T,
        listener: Listener<Events, Arguments, T>,
    ): this {
        return super.removeListener(event, listener);
    }

    public rawListeners(event: Events | EventEmitterEvents): Function[] {
        return super.rawListeners(event);
    }
}
