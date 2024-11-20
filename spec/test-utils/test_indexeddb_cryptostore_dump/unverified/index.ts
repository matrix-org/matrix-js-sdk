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
const KEY_QUERY_RESPONSE = {
    device_keys: {
        "@untrusted:localhost": {
            IXNYALOZWU: {
                algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
                device_id: "IXNYALOZWU",
                keys: {
                    "curve25519:IXNYALOZWU": "EHMQEtJd9INJg28HwKK8Te1EX8obR3VTtyNwf/rcczM",
                    "ed25519:IXNYALOZWU": "OxMfZHsYJvroTp1RtjUOejpWbRBryN6VsojC5dKR74U",
                },
                signatures: {
                    "@untrusted:localhost": {
                        "ed25519:IXNYALOZWU":
                            "tWaTiRKc95ZCqM2qrKTdq1sQ3DPFgw3vdrOVmWIHQwj92DCgJtnQ9uymLMOq+MSb80bdBBjXwrNeOufgaL/6CQ",
                        "ed25519:+ik0n/QnBPq8H/48wAT+54slKk1SL7NIk/HtiN/cNEg":
                            "+QXZFLiAv+k7UXgAP6AXLk/PdZ3TlJ77M23m73v8qvavAlnkLBAjKNA3BG39JTQET5UhW5DnCohwsbGP+aY1Cw",
                    },
                },
                user_id: "@untrusted:localhost",
                unsigned: {
                    device_display_name: "localhost:8080: Chrome on macOS",
                },
            },
            VJPSPVPWZT: {
                algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
                device_id: "VJPSPVPWZT",
                keys: {
                    "curve25519:VJPSPVPWZT": "+RxCNRFPqBZJm6PLjEJsSdFixGWQJygD5Os11/+6PC0",
                    "ed25519:VJPSPVPWZT": "wqH7xK/DQya8m05Vy4rnacjugGNBiY+7Ml6wyRVkM9U",
                },
                signatures: {
                    "@untrusted:localhost": {
                        "ed25519:VJPSPVPWZT":
                            "XC+RoKL/zVZOIwk/bGEQJlJu49QicY1v6vSDMHA2y0/fpX/MD4KiWGD7+W5DFD54E8FrFVTsIgkzat561qdTBQ",
                    },
                },
                user_id: "@untrusted:localhost",
                unsigned: {
                    device_display_name: "localhost:8080: Chrome on macOS",
                },
            },
        },
    },
    failures: {},
    master_keys: {
        "@untrusted:localhost": {
            keys: {
                "ed25519:Uahbc3+Rk65y0ku6T2RL/29fEA9Bum6+OaqptG6df3g": "Uahbc3+Rk65y0ku6T2RL/29fEA9Bum6+OaqptG6df3g",
            },
            signatures: {
                "@untrusted:localhost": {
                    "ed25519:IXNYALOZWU":
                        "KdAdyKO2sb3Di3bdK+oxf+gjMSmW/sisRNvpKZORPKwmy2SGaKGYkecBtslunoFjnb+hjIESgweQu6cHoNX4AA",
                    "ed25519:Uahbc3+Rk65y0ku6T2RL/29fEA9Bum6+OaqptG6df3g":
                        "b0R9Id5HxHYo+MA22Vlq0OckTrWnSWhgHLvF8Wr4e154JdtOyK7N0aXPQPkrLB0fmyVmGdbDa9xs9jsfINGmDw",
                },
            },
            usage: ["master"],
            user_id: "@untrusted:localhost",
        },
    },
    self_signing_keys: {
        "@untrusted:localhost": {
            keys: {
                "ed25519:+ik0n/QnBPq8H/48wAT+54slKk1SL7NIk/HtiN/cNEg": "+ik0n/QnBPq8H/48wAT+54slKk1SL7NIk/HtiN/cNEg",
            },
            signatures: {
                "@untrusted:localhost": {
                    "ed25519:Uahbc3+Rk65y0ku6T2RL/29fEA9Bum6+OaqptG6df3g":
                        "z/5z51jbRpyDQhYnfUHhhb5fUbzRDlfjD8mZA2ZGStpE/F41lDyxjlvF2W/E2CJ27bmJFdk7nC+ZCwriYfYxBw",
                },
            },
            usage: ["self_signing"],
            user_id: "@untrusted:localhost",
        },
    },
    user_signing_keys: {
        "@untrusted:localhost": {
            keys: {
                "ed25519:L/8HbQWnK9OidAcDVB+Az9b0Mx3OdBtIMFsUjV6qgSQ": "L/8HbQWnK9OidAcDVB+Az9b0Mx3OdBtIMFsUjV6qgSQ",
            },
            signatures: {
                "@untrusted:localhost": {
                    "ed25519:Uahbc3+Rk65y0ku6T2RL/29fEA9Bum6+OaqptG6df3g":
                        "UuNvzebLQn31LYGbx+ADe60BB25kWy4SVVyd9BXlY/tAZMoA8Tmq1e2R2tJJtPdJxC/Oogktj2+iikZV/YMjAQ",
                },
            },
            usage: ["user_signing"],
            user_id: "@untrusted:localhost",
        },
    },
};

/**
 * A dataset containing the information for the tested user.
 * To be used during tests.
 */
export const IDENTITY_NOT_TRUSTED_DATASET: DumpDataSetInfo = {
    userId: "@untrusted:localhost",
    deviceId: "VJPSPVPWZT",
    pickleKey: "WVllQb4Lk/WwP4Q7iBfeTUHpgydZm9YqXI1B5bTvnIM",
    keyQueryResponse: KEY_QUERY_RESPONSE,
    dumpPath: "spec/test-utils/test_indexeddb_cryptostore_dump/unverified/dump.json",
};
