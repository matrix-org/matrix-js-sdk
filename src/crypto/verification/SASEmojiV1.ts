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

import v1Emoji from "../../../res/sas-emoji.json";

export interface ITranslations {
    [languageCode: string]: string;
}

/**
 * Some useful utilities for accessing the SAS v1 emoji data.
 */
export class SASEmojiV1 {
    public static getEmojiPair(index: number): [string, string] {
        return [SASEmojiV1.getEmoji(index), SASEmojiV1.getName(index).toLowerCase()]; // .toLowerCase() for compat
    }

    public static getEmoji(index: number): string {
        return v1Emoji[index].emoji;
    }

    public static getName(index: number): string {
        return v1Emoji[index].description;
    }

    public static getTranslations(index: number): ITranslations {
        return v1Emoji[index].translated_descriptions;
    }

    public static getNameFor(emoji: string): string {
        for (const e of v1Emoji) {
            if (e.emoji === emoji) {
                return e.description;
            }
        }
        throw new Error("Emoji not found");
    }

    public static getNumberFor(emoji: string): number {
        for (const e of v1Emoji) {
            if (e.emoji === emoji) {
                return e.number;
            }
        }
        throw new Error("Emoji not found");
    }

    public static getTranslationsFor(emoji: string): ITranslations {
        for (const e of v1Emoji) {
            if (e.emoji === emoji) {
                return e.translated_descriptions;
            }
        }
        throw new Error("Emoji not found");
    }

    public static getAllEmoji(): string[] {
        return v1Emoji.map(e => e.emoji);
    }
}
