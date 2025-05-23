/*
Copyright 2020 The Matrix.org Foundation C.I.C.

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

export {};

declare global {
    // use `number` as the return type in all cases for globalThis.set{Interval,Timeout},
    // so we don't accidentally use the methods on NodeJS.Timeout - they only exist in a subset of environments.
    // The overload for clear{Interval,Timeout} is resolved as expected.
    // We use `ReturnType<typeof setTimeout>` in the code to be agnostic of if this definition gets loaded.
    function setInterval(handler: TimerHandler, timeout: number, ...arguments: any[]): number;
    function setTimeout(handler: TimerHandler, timeout: number, ...arguments: any[]): number;

    namespace NodeJS {
        interface Global {
            // marker variable used to detect both the browser & node entrypoints being used at once
            __js_sdk_entrypoint: unknown;
        }
    }

    // Chrome-specific getUserMedia constraints
    interface MediaTrackConstraints {
        mandatory?: {
            chromeMediaSource: string;
            chromeMediaSourceId: string;
        };
    }

    interface Navigator {
        // We check for the webkit-prefixed getUserMedia to detect if we're
        // on webkit: we should check if we still need to do this
        webkitGetUserMedia?: unknown;
    }

    export interface Uint8ArrayToBase64Options {
        alphabet?: "base64" | "base64url";
        omitPadding?: boolean;
    }

    interface Uint8Array {
        // https://tc39.es/proposal-arraybuffer-base64/spec/#sec-uint8array.prototype.tobase64
        toBase64?(options?: Uint8ArrayToBase64Options): string;
    }

    export interface Uint8ArrayFromBase64Options {
        alphabet?: "base64"; // Our fallback code only handles base64.
        lastChunkHandling?: "loose"; // Our fallback code doesn't support other handling at this time.
    }

    interface Uint8ArrayConstructor {
        // https://tc39.es/proposal-arraybuffer-base64/spec/#sec-uint8array.frombase64
        fromBase64?(base64: string, options?: Uint8ArrayFromBase64Options): Uint8Array;
    }
}
