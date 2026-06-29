/*
Copyright 2026 The Matrix.org Foundation C.I.C.

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

import { logger } from "../logger.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

export const hasRequiredStringProperty = <K extends string>(
    metadata: Record<string, unknown>,
    key: K,
): metadata is Record<string, unknown> & Record<K, string> => {
    if (!metadata[key] || !hasOptionalStringProperty(metadata, key)) {
        logger.error(`Missing or invalid property: ${key}`);
        return false;
    }
    return true;
};

export const hasOptionalStringProperty = <K extends string>(
    metadata: Record<string, unknown>,
    key: K,
): metadata is Record<string, unknown> & Record<K, string | undefined> => {
    if (!!metadata[key] && typeof metadata[key] !== "string") {
        logger.error(`Invalid property: ${key}`);
        return false;
    }
    return true;
};

export const hasRequiredNumberProperty = <K extends string>(
    metadata: Record<string, unknown>,
    key: K,
): metadata is Record<string, unknown> & Record<K, number> => {
    if (!metadata[key] || !hasOptionalNumberProperty(metadata, key)) {
        logger.error(`Missing or invalid property: ${key}`);
        return false;
    }
    return true;
};

export const hasOptionalNumberProperty = <K extends string>(
    metadata: Record<string, unknown>,
    key: K,
): metadata is Record<string, unknown> & Record<K, number | undefined> => {
    if (!!metadata[key] && typeof metadata[key] !== "number") {
        logger.error(`Invalid property: ${key}`);
        return false;
    }
    return true;
};

export const optionalStringArrayProperty = <K extends string>(
    metadata: Record<string, unknown>,
    key: K,
): metadata is Record<string, unknown> & Record<K, string[] | undefined> => {
    if (
        !!metadata[key] &&
        (!Array.isArray(metadata[key]) || !(<unknown[]>metadata[key]).every((v) => typeof v === "string"))
    ) {
        logger.error(`Invalid property: ${key}`);
        return false;
    }
    return true;
};

export const requiredArrayValue = <K extends string, V>(
    metadata: Record<string, unknown>,
    key: K,
    value: V,
): metadata is Record<string, unknown> & Record<K, V[]> => {
    const array = metadata[key];
    if (!array || !Array.isArray(array) || !array.includes(value)) {
        logger.error(`Invalid property: ${key}. ${value} is required.`);
        return false;
    }
    return true;
};
