/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Types for JSON and JSON objects, copied from element-web (left in both places as I don't think we
// want this as a part of js-sdk's interface and I don't think it's worth it being its own package)

export type JsonValue = null | string | number | boolean;
export type JsonArray = Array<JsonValue | JsonObject | JsonArray>;
export interface JsonObject {
    [key: string]: JsonObject | JsonArray | JsonValue;
}
export type Json = JsonArray | JsonObject;
