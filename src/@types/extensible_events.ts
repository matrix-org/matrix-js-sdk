/*
Copyright 2021 - 2023 The Matrix.org Foundation C.I.C.

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

import { EitherAnd, NamespacedValue, UnstableValue } from "matrix-events-sdk";

import { isProvided } from "../extensible_events_v1/utilities";

// Types and utilities for MSC1767: Extensible events (version 1) in Matrix

/**
 * Represents the stable and unstable values of a given namespace.
 */
export type TSNamespace<N> = N extends NamespacedValue<infer S, infer U>
    ? TSNamespaceValue<S> | TSNamespaceValue<U>
    : never;

/**
 * Represents a namespaced value, if the value is a string. Used to extract provided types
 * from a TSNamespace<N> (in cases where only stable *or* unstable is provided).
 */
export type TSNamespaceValue<V> = V extends string ? V : never;

/**
 * Creates a type which is V when T is `never`, otherwise T.
 */
// See https://github.com/microsoft/TypeScript/issues/23182#issuecomment-379091887 for details on the array syntax.
export type DefaultNever<T, V> = [T] extends [never] ? V : T;

/**
 * The namespaced value for m.message
 */
export const M_MESSAGE = new UnstableValue("m.message", "org.matrix.msc1767.message");

/**
 * An m.message event rendering
 */
export interface IMessageRendering {
    body: string;
    mimetype?: string;
}

/**
 * The content for an m.message event
 */
export type M_MESSAGE_EVENT = EitherAnd<
    { [M_MESSAGE.name]: IMessageRendering[] },
    { [M_MESSAGE.altName]: IMessageRendering[] }
>;

/**
 * The namespaced value for m.text
 */
export const M_TEXT = new UnstableValue("m.text", "org.matrix.msc1767.text");

/**
 * The content for an m.text event
 */
export type M_TEXT_EVENT = EitherAnd<{ [M_TEXT.name]: string }, { [M_TEXT.altName]: string }>;

/**
 * The namespaced value for m.html
 */
export const M_HTML = new UnstableValue("m.html", "org.matrix.msc1767.html");

/**
 * The content for an m.html event
 */
export type M_HTML_EVENT = EitherAnd<{ [M_HTML.name]: string }, { [M_HTML.altName]: string }>;

/**
 * The content for an m.message, m.text, or m.html event
 */
export type M_MESSAGE_EVENT_CONTENT = M_MESSAGE_EVENT | M_TEXT_EVENT | M_HTML_EVENT;

/**
 * The namespaced value for an m.reference relation
 */
export const REFERENCE_RELATION = new NamespacedValue("m.reference");

/**
 * Represents any relation type
 */
export type ANY_RELATION = TSNamespace<typeof REFERENCE_RELATION> | string;

/**
 * An m.relates_to relationship
 */
export type RELATES_TO_RELATIONSHIP<R = never, C = never> = {
    "m.relates_to": {
        // See https://github.com/microsoft/TypeScript/issues/23182#issuecomment-379091887 for array syntax
        rel_type: [R] extends [never] ? ANY_RELATION : TSNamespace<R>;
        event_id: string;
    } & DefaultNever<C, {}>;
};

/**
 * Partial types for a Matrix Event.
 */
export interface IPartialEvent<TContent> {
    type: string;
    content: TContent;
}

/**
 * Represents a potentially namespaced event type.
 */
export type ExtensibleEventType = NamespacedValue<string, string> | string;

/**
 * Determines if two event types are the same, including namespaces.
 * @param given - The given event type. This will be compared
 * against the expected type.
 * @param expected - The expected event type.
 * @returns True if the given type matches the expected type.
 */
export function isEventTypeSame(given: ExtensibleEventType, expected: ExtensibleEventType): boolean {
    if (typeof given === "string") {
        if (typeof expected === "string") {
            return expected === given;
        } else {
            return (expected as NamespacedValue<string, string>).matches(given as string);
        }
    } else {
        if (typeof expected === "string") {
            return (given as NamespacedValue<string, string>).matches(expected as string);
        } else {
            const expectedNs = expected as NamespacedValue<string, string>;
            const givenNs = given as NamespacedValue<string, string>;
            return (
                expectedNs.matches(givenNs.name) ||
                (isProvided(givenNs.altName) && expectedNs.matches(givenNs.altName!))
            );
        }
    }
}
