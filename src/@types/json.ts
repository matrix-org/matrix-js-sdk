/*
Copyright 2024 New Vector Ltd.

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

// Types for JSON and JSON objects, copied from element-web (left in both places as I don't think we
// want this as a part of js-sdk's interface and I don't think it's worth it being its own package)

export type JsonValue = null | string | number | boolean;
export type JsonArray = Array<JsonValue | JsonObject | JsonArray>;
export interface JsonObject {
    [key: string]: JsonObject | JsonArray | JsonValue;
}
export type Json = JsonArray | JsonObject;
