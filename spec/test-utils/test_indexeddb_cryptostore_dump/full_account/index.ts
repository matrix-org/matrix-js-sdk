/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { DumpDataSetInfo } from "../index";

/**
 * A key query response containing the current keys of the tested user.
 * To be used during tests with fetchmock.
 */
const KEYS_QUERY_RESPONSE: any = {
    device_keys: {
        "@vdhtest200713:matrix.org": {
            KMFSTJSMLB: {
                algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
                device_id: "KMFSTJSMLB",
                keys: {
                    "curve25519:KMFSTJSMLB": "LKv0bKbc0EC4h0jknbemv3QalEkeYvuNeUXVRgVVTTU",
                    "ed25519:KMFSTJSMLB": "qK70DEqIXq7T+UU3v/al47Ab4JkMEBLpNrTBMbS5rrw",
                },
                user_id: "@vdhtest200713:matrix.org",
                signatures: {
                    "@vdhtest200713:matrix.org": {
                        "ed25519:KMFSTJSMLB":
                            "aE+PdxLAdwQ/xfJwLmqebvt/lrT97fZas2SQFFrM+dPmHxQtjyS8csm88BLfGRjJKK1B/vWev3AaKqQZwLTUAw",
                        "ed25519:lDvg6vi3P80L9XFNpUSU+5Y87m3p6yHcC83jhSU4Q5k":
                            "lCd4SA/JT1nnxsgN9yQaLJQhH5hkLMVVx6ba5JAjL1wpWVqyPxzMJHImX6vTztk6S8rybcdfYkea5W/Ii+4HCQ",
                    },
                },
            },
        },
    },
    master_keys: {
        "@vdhtest200713:matrix.org": {
            user_id: "@vdhtest200713:matrix.org",
            usage: ["master"],
            keys: {
                "ed25519:gh9fGr39eNZUdWynEMJ/q/WZq/Pk/foFxHXFBFm18ZI": "gh9fGr39eNZUdWynEMJ/q/WZq/Pk/foFxHXFBFm18ZI",
            },
            signatures: {
                "@vdhtest200713:matrix.org": {
                    "ed25519:MWOGVUTXZN":
                        "stOu1aHbhsWB/Aj5M/HqBR83QzME+682C995Uc8JxSmmyrlWmgG8QrnoUDG2OFR1t6zNQ+QLEilU4WNEOV73DQ",
                },
            },
        },
    },
    self_signing_keys: {
        "@vdhtest200713:matrix.org": {
            user_id: "@vdhtest200713:matrix.org",
            usage: ["self_signing"],
            keys: {
                "ed25519:lDvg6vi3P80L9XFNpUSU+5Y87m3p6yHcC83jhSU4Q5k": "lDvg6vi3P80L9XFNpUSU+5Y87m3p6yHcC83jhSU4Q5k",
            },
            signatures: {
                "@vdhtest200713:matrix.org": {
                    "ed25519:gh9fGr39eNZUdWynEMJ/q/WZq/Pk/foFxHXFBFm18ZI":
                        "HKTC7NoBhAkfJtmemmkn/HvCCgBQViWZ0uH7aGPRaWMDFgD8T7Q+y1j3FKZv4mhSopR85Fq3FRyXsG8OVvGeBA",
                },
            },
        },
    },
    user_signing_keys: {
        "@vdhtest200713:matrix.org": {
            user_id: "@vdhtest200713:matrix.org",
            usage: ["user_signing"],
            keys: {
                "ed25519:YShqO/3u5vQ0uucojraWrtoLrek0CYrurN/vH/YPMg8": "YShqO/3u5vQ0uucojraWrtoLrek0CYrurN/vH/YPMg8",
            },
            signatures: {
                "@vdhtest200713:matrix.org": {
                    "ed25519:gh9fGr39eNZUdWynEMJ/q/WZq/Pk/foFxHXFBFm18ZI":
                        "u8VOi4IaeRJwDgy2ftK02NJQPdBijy8f/0+WnHGG72yfOvMthwWzEw8SrRSNG8glBNrfHinKwCyJJzAJwyepCQ",
                },
            },
        },
    },
};

/**
 * A `/room_keys/version` response containing the current server-side backup info.
 * To be used during tests with fetchmock.
 */
const BACKUP_RESPONSE: any = {
    auth_data: {
        public_key: "q+HZiJdHl2Yopv9GGvv7EYSzDMrAiRknK4glSdoaomI",
        signatures: {
            "@vdhtest200713:matrix.org": {
                "ed25519:gh9fGr39eNZUdWynEMJ/q/WZq/Pk/foFxHXFBFm18ZI":
                    "reDp6Mu+j+tfUL3/T6f5OBT3N825Lzpc43vvG+RvjX6V+KxXzodBQArgCoeEHLtL9OgSBmNrhTkSOX87MWCKAw",
                "ed25519:KMFSTJSMLB":
                    "F8tyV5W6wNi0GXTdSg+gxSCULQi0EYxdAAqfkyNq58KzssZMw5i+PRA0aI2b+D7NH/aZaJrtiYNHJ0gWLSQvAw",
            },
        },
    },
    version: "7",
    algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
    etag: "1",
    count: 79,
};

/**
 * A dataset containing the information for the tested user.
 * To be used during tests.
 */
export const FULL_ACCOUNT_DATASET: DumpDataSetInfo = {
    userId: "@vdhtest200713:matrix.org",
    deviceId: "KMFSTJSMLB",
    pickleKey: "+1k2Ppd7HIisUY824v7JtV3/oEE4yX0TqtmNPyhaD7o",
    backupResponse: BACKUP_RESPONSE,
    keyQueryResponse: KEYS_QUERY_RESPONSE,
    dumpPath: "spec/test-utils/test_indexeddb_cryptostore_dump/full_account/dump.json",
};
