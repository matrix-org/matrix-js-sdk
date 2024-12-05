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

import { KeyBackupInfo } from "../../../../src/crypto-api/keybackup";
import { DumpDataSetInfo } from "../index";

/**
 * A key query response containing the current keys of the tested user.
 * To be used during tests with fetchmock.
 */
const KEY_QUERY_RESPONSE: any = {
    device_keys: {
        "@migration:localhost": {
            CBGTADUILV: {
                algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
                device_id: "CBGTADUILV",
                keys: {
                    "curve25519:CBGTADUILV": "gqhFlc7Wzc1wmmmAu3ySIEe4LtDcBK/bdzrtZg+mMSg",
                    "ed25519:CBGTADUILV": "q1q3L1Il4l61c/6TmI4fYWMsseNMJJYE2Y0r+5ajKQI",
                },
                signatures: {
                    "@migration:localhost": {
                        "ed25519:CBGTADUILV":
                            "ppSmA0slyQ7RJOFn+qZSLCGeHN6/jAmqKvUZo5Q1hWk0ugkKycRoSUi9TOfbfAVSf8xvFirXy2VGXQbEVPJqAA",
                        "ed25519:d+4HhsodR2Zqv4Z5V0VxPfy8zbjLjUCdCyv5qme5Ygc":
                            "cFLWl1fjehLrzrEn3UnmZMIgy3C23WMgGRsn4e6Z/55vmen4KMs8bLpgZaDoWhIdn/8siHRWafA5sFdzK2NsBQ",
                        "ed25519:bmFmNcVPvaqrlNzmyKn9uU+QRHyx2QRbn/bUAlTH760":
                            "C6EeqNPcaQyuZgo8+HOUywc/TMkW5IMjg7aoxyu93X//KcNNXKRfj1banYP6XqyPuQITLamBYc1089Jpt9g4Cw",
                        "ed25519:RkQzi0+aKIL9Y+GzsN23xMz3i3QRkH03G5aqqEbbuy4":
                            "YwBN/SbCxO8hPgv1B9JY2WVFK4LNK9vq1UNVrkF2j0ZDw9LrvaOws72mbmzZ0nbD3ohcEZ8rXsEosxEVr5r7AQ",
                    },
                },
                user_id: "@migration:localhost",
                unsigned: {
                    device_display_name: "localhost:8080: Chrome on macOS",
                },
            },
            TMWBMDZPFT: {
                algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
                device_id: "TMWBMDZPFT",
                keys: {
                    "curve25519:TMWBMDZPFT": "oYP9EXvHMbliFdfk8jPvUw0KhAd0+PBqdMslJAt/ZGQ",
                    "ed25519:TMWBMDZPFT": "IyfPT67JutFWJsUxrxSqEWxgRjKn9B/w78uKU4OBj1E",
                },
                signatures: {
                    "@migration:localhost": {
                        "ed25519:TMWBMDZPFT":
                            "IWIuuDag4ZMDhMObYV63X7dBYEUYNHYR0Yu/bwLvQh5ieDjQSrZSLOzDrgCyPCM4hkc4JlhneQpJsYo1lUH7DA",
                        "ed25519:d+4HhsodR2Zqv4Z5V0VxPfy8zbjLjUCdCyv5qme5Ygc":
                            "iEcTKElQu4CAsQIXmBaZmXwfB6Diut+4ZXakP1ob7OIDMrCYBcgXsBFYg6GuxwL0LCTVcUgbUw7VuPKSvM8UAA",
                        "ed25519:MYgcP5P7P6KucWjLvTRofY5PWxsf+WDj2BiXtqOO5Gw":
                            "KcBLDWkCwZyIzlBkC29PNzHxx7Br14TYlhBfREEEQo/Rd34ZZUYwbQ8iPhB8S1GVq3YwgAV6piYIcxpQin+dBA",
                        "ed25519:HGN9m99VprMuQBDA3o+KZKcEYTaGmiaujrkygjScMnY":
                            "VqrvA148Uxib9TNFI1rc9r8qpwTojCkqLofEz9dMLc/XV3U14WD5/LDEhMuCwNu6wsu/uO+dS4AmJlJnN/iAAg",
                        "ed25519:Nt0L/p+UVHMx603sYHXwXja+VyQIUVFvu0vDBYn56Zk":
                            "D1COHzROOTNlCn8b1zI9+6phUtF0OVqWxLfOLnX5t14H2oENYV2ASgaxsdmXcSZPrGzaJkmSOginHHzsabe5CA",
                        "ed25519:bmFmNcVPvaqrlNzmyKn9uU+QRHyx2QRbn/bUAlTH760":
                            "SFSDrsi3GQ9jjBYUc2aUSzf777/0NfQWrOBi2CK+v5VQY3FkyHBln3K4YzvxIKSVIhOaQtBlEDtfQb33kwTgDg",
                        "ed25519:RkQzi0+aKIL9Y+GzsN23xMz3i3QRkH03G5aqqEbbuy4":
                            "BtJkzQe0YFAa8gJiYXYtzGtktl9vZMNYl5jd4DA8Toi4VxgosJNZQE7lT5qpYU0BrlFn46QIs/38X8JhSt+wAQ",
                    },
                },
                user_id: "@migration:localhost",
                unsigned: {
                    device_display_name: "localhost:8080: Chrome on macOS",
                },
            },
        },
    },
    failures: {},
    master_keys: {
        "@migration:localhost": {
            keys: {
                "ed25519:cFjUBAhAZ2tjYF1TpQtYNA3x9XRzTiIdP2N2EvRaOH4": "cFjUBAhAZ2tjYF1TpQtYNA3x9XRzTiIdP2N2EvRaOH4",
            },
            signatures: {
                "@migration:localhost": {
                    "ed25519:TMWBMDZPFT":
                        "RrPUnYoekK7wZGrLNXshgoupF8v53S/vJyvkBJi+q9THh4Qrf3CieuVJFx8mwtmEZgGoA2tSroAVnRqvEQ+IBQ",
                    "ed25519:cFjUBAhAZ2tjYF1TpQtYNA3x9XRzTiIdP2N2EvRaOH4":
                        "o4CbtdU3IqJK90UXAEBtxps2m4XBYvWJI2nbVlzBaGRr+Xt/3vtwDMlc5G970kPQWBbs/koYJh8MSaE7Fm1mAg",
                    "ed25519:CBGTADUILV":
                        "AgZoG+ix8aW3FAW6v+/Xu+QJpxzvsx5itbB8RyqMet9YlNqX90vYIbBV7IoV2WFY2WdANYEffX2CE0FpR6NnCg",
                },
            },
            usage: ["master"],
            user_id: "@migration:localhost",
        },
    },
    self_signing_keys: {
        "@migration:localhost": {
            keys: {
                "ed25519:RkQzi0+aKIL9Y+GzsN23xMz3i3QRkH03G5aqqEbbuy4": "RkQzi0+aKIL9Y+GzsN23xMz3i3QRkH03G5aqqEbbuy4",
            },
            signatures: {
                "@migration:localhost": {
                    "ed25519:cFjUBAhAZ2tjYF1TpQtYNA3x9XRzTiIdP2N2EvRaOH4":
                        "hs8VqoTfipDjC2pzFdmzb1aENhDjVV+gc86fuYftczaCcsXUWop/NPwoF51Ie6Nb3YL0N7ZZAUrycuJP5hFbDg",
                },
            },
            usage: ["self_signing"],
            user_id: "@migration:localhost",
        },
    },
    user_signing_keys: {
        "@migration:localhost": {
            keys: {
                "ed25519:WNJ2G3Ig5EdC4wYiRKcK7bhLP2+I4wI6V7SKgJTXdw8": "WNJ2G3Ig5EdC4wYiRKcK7bhLP2+I4wI6V7SKgJTXdw8",
            },
            signatures: {
                "@migration:localhost": {
                    "ed25519:cFjUBAhAZ2tjYF1TpQtYNA3x9XRzTiIdP2N2EvRaOH4":
                        "Vlba5rJQxG+ussVLoycvHcin7Ghv0uUeClDqDbM+RPF+jx9w4ozbcuEOTJdyzyPA+GxN9Kzh2lmVFMMQGyvNAw",
                },
            },
            usage: ["user_signing"],
            user_id: "@migration:localhost",
        },
    },
};

/**
 * A new  key query response for the same user simulating a cross-signing key reset.
 * To be used during tests with fetchmock.
 */
const ROTATED_KEY_QUERY_RESPONSE: any = {
    device_keys: {
        "@migration:localhost": {
            TMWBMDZPFT: {
                algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
                device_id: "TMWBMDZPFT",
                keys: {
                    "curve25519:TMWBMDZPFT": "oYP9EXvHMbliFdfk8jPvUw0KhAd0+PBqdMslJAt/ZGQ",
                    "ed25519:TMWBMDZPFT": "IyfPT67JutFWJsUxrxSqEWxgRjKn9B/w78uKU4OBj1E",
                },
                signatures: {
                    "@migration:localhost": {
                        "ed25519:TMWBMDZPFT":
                            "IWIuuDag4ZMDhMObYV63X7dBYEUYNHYR0Yu/bwLvQh5ieDjQSrZSLOzDrgCyPCM4hkc4JlhneQpJsYo1lUH7DA",
                        "ed25519:d+4HhsodR2Zqv4Z5V0VxPfy8zbjLjUCdCyv5qme5Ygc":
                            "iEcTKElQu4CAsQIXmBaZmXwfB6Diut+4ZXakP1ob7OIDMrCYBcgXsBFYg6GuxwL0LCTVcUgbUw7VuPKSvM8UAA",
                        "ed25519:MYgcP5P7P6KucWjLvTRofY5PWxsf+WDj2BiXtqOO5Gw":
                            "KcBLDWkCwZyIzlBkC29PNzHxx7Br14TYlhBfREEEQo/Rd34ZZUYwbQ8iPhB8S1GVq3YwgAV6piYIcxpQin+dBA",
                        "ed25519:HGN9m99VprMuQBDA3o+KZKcEYTaGmiaujrkygjScMnY":
                            "VqrvA148Uxib9TNFI1rc9r8qpwTojCkqLofEz9dMLc/XV3U14WD5/LDEhMuCwNu6wsu/uO+dS4AmJlJnN/iAAg",
                        "ed25519:Nt0L/p+UVHMx603sYHXwXja+VyQIUVFvu0vDBYn56Zk":
                            "D1COHzROOTNlCn8b1zI9+6phUtF0OVqWxLfOLnX5t14H2oENYV2ASgaxsdmXcSZPrGzaJkmSOginHHzsabe5CA",
                        "ed25519:bmFmNcVPvaqrlNzmyKn9uU+QRHyx2QRbn/bUAlTH760":
                            "SFSDrsi3GQ9jjBYUc2aUSzf777/0NfQWrOBi2CK+v5VQY3FkyHBln3K4YzvxIKSVIhOaQtBlEDtfQb33kwTgDg",
                        "ed25519:RkQzi0+aKIL9Y+GzsN23xMz3i3QRkH03G5aqqEbbuy4":
                            "BtJkzQe0YFAa8gJiYXYtzGtktl9vZMNYl5jd4DA8Toi4VxgosJNZQE7lT5qpYU0BrlFn46QIs/38X8JhSt+wAQ",
                    },
                },
                user_id: "@migration:localhost",
                unsigned: {
                    device_display_name: "localhost:8080: Chrome on macOS",
                },
            },
            XFZFSCUOFL: {
                algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
                device_id: "XFZFSCUOFL",
                keys: {
                    "curve25519:XFZFSCUOFL": "aN2Ty+0rutNkrRtxhV+ciI8GhF4epSxzL7bAOr8zfkc",
                    "ed25519:XFZFSCUOFL": "V7CPhXdfLFk+qAOFivrpFskmunVTeuM+EOM3DMlDxkI",
                },
                signatures: {
                    "@migration:localhost": {
                        "ed25519:XFZFSCUOFL":
                            "4Pqc2FWJ5p/L/tSlfUBIlcQzLmN5CksJriAibY8LSDAXdGYiQJ7hvKqneEuVhrMYwqyIxb4bAad+r6wnY0/7Cg",
                        "ed25519:RkQzi0+aKIL9Y+GzsN23xMz3i3QRkH03G5aqqEbbuy4":
                            "yH8pKnD+E8YaawS+1NCjwy0cf2WzBRff9BBNX4YnAuTyc6s5b1QqNfu9DP5qblw8TZ7hZmaziePZKsjRiqJLBg",
                        "ed25519:OEv0wHLusJx7zTCc0h3HbNIHLIxlGZKh63tc2ptKb+Y":
                            "M8SfAiEUzd7AsWp8InS7BxV3cRqV3MjMxks4DwSxsVxvkCco2JWybKgev+vTZyM6XDg930o0FObQOxWm4+CkBw",
                    },
                },
                user_id: "@migration:localhost",
                unsigned: {
                    device_display_name: "localhost:8080: Chrome on macOS",
                },
            },
        },
    },
    failures: {},
    master_keys: {
        "@migration:localhost": {
            user_id: "@migration:localhost",
            usage: ["master"],
            keys: {
                "ed25519:rXCrBin/+xyh+yW//vWte+2UV0et1ZHTWfalp/Ekack": "rXCrBin/+xyh+yW//vWte+2UV0et1ZHTWfalp/Ekack",
            },
            signatures: {
                "@migration:localhost": {
                    "ed25519:XFZFSCUOFL":
                        "C8aswtyUABWvj2DInehVoh2P/EDbwRhlIk51LtV3L71POUCh7pZuyXRMMWKZeyRvHRmEllXBtRkH1iol/p56Bg",
                },
            },
        },
    },
    self_signing_keys: {
        "@migration:localhost": {
            user_id: "@migration:localhost",
            usage: ["self_signing"],
            keys: {
                "ed25519:OEv0wHLusJx7zTCc0h3HbNIHLIxlGZKh63tc2ptKb+Y": "OEv0wHLusJx7zTCc0h3HbNIHLIxlGZKh63tc2ptKb+Y",
            },
            signatures: {
                "@migration:localhost": {
                    "ed25519:rXCrBin/+xyh+yW//vWte+2UV0et1ZHTWfalp/Ekack":
                        "dH596pGp8+f8dlwd81UrKDWoRDd24yAqqMSLqR4fJHyfszbn7qCvQA6LYZ023TLmk33FKcJqRtd2v/ykTmS3Bg",
                },
            },
        },
    },
    user_signing_keys: {
        "@migration:localhost": {
            user_id: "@migration:localhost",
            usage: ["user_signing"],
            keys: {
                "ed25519:8XHpC3MeMReIfYneWIRX8c4ANgJuQ1+oFrktBcLka4o": "8XHpC3MeMReIfYneWIRX8c4ANgJuQ1+oFrktBcLka4o",
            },
            signatures: {
                "@migration:localhost": {
                    "ed25519:rXCrBin/+xyh+yW//vWte+2UV0et1ZHTWfalp/Ekack":
                        "FX6ylagvx3IG1zMf/ayYgDb/1+x0/F28pHQqzQMGGssAmc15nat/R6AF0QO7Qg7uqTAf04ohuZtWax3dTwjNDQ",
                },
            },
        },
    },
};

/**
 * A `/room_keys/version` response containing the current server-side backup info.
 * To be used during tests with fetchmock.
 */
const BACKUP_RESPONSE: KeyBackupInfo = {
    auth_data: {
        public_key: "2ffIfIB4oryqZpsJQjQNUaxgCzxliC6A4PJvnrN+XAA",
        signatures: {
            "@migration:localhost": {
                "ed25519:TMWBMDZPFT":
                    "qBvalid/G4hnSF3hAeX4TtRN6/BqprgiYnLEtDuatyQ5WxWr0s4uSOyvHSglsRdpoo32FDBHfTIZkCOVxSLwAA",
            },
        },
    },
    version: "2",
    algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
    etag: "0",
    count: 0,
};

/**
 * This was generated by doing a backup reset on the account.
 * This is a new valid backup for this account.
 */
const NEW_BACKUP_RESPONSE: KeyBackupInfo = {
    auth_data: {
        public_key: "CkDxWALi3lcChgjEZFEM6clYq5x768XBwsL++eaOzTI",
        signatures: {
            "@migration:localhost": {
                "ed25519:YVEGEYPYWX":
                    "ZSYuQDdwgB9WKXQ+z5aWWfqSolBCGRw53kur1Vy956gFefgzCBkMbw5M0I2UgfU2Cukri7jZ4ig201zmLNmaAA",
                "ed25519:rXCrBin/+xyh+yW//vWte+2UV0et1ZHTWfalp/Ekack":
                    "+UQ8EA507LoIqgK9rPsqPoGrj+iRBJeY2Oz0mMtXmVf8c1y8G0KWJNUWqvOysnOhsoJf1bt8ey48CxjjtSQ2AA",
            },
        },
    },
    version: "3",
    algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
    etag: "0",
    count: 0,
};

/**
 * A dataset containing the information for the tested user.
 * To be used during tests.
 */
export const MSK_NOT_CACHED_DATASET: DumpDataSetInfo = {
    userId: "@migration:localhost",
    deviceId: "CBGTADUILV",
    pickleKey: "qEURMepfkMvoBQGaWlI9MZKYnDMsSAiW8aFTKXaeDV0",
    keyQueryResponse: KEY_QUERY_RESPONSE,
    rotatedKeyQueryResponse: ROTATED_KEY_QUERY_RESPONSE,
    backupResponse: BACKUP_RESPONSE,
    newBackupResponse: NEW_BACKUP_RESPONSE,
    dumpPath: "spec/test-utils/test_indexeddb_cryptostore_dump/no_cached_msk_dump/dump.json",
};
