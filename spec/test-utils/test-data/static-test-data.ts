/* 
 * Static Test data for cryptography tests
 */

import { IMegolmSessionData } from "../../../src/@types/crypto";

export const MEGOLM_SESSION_DATA_ARRAY: IMegolmSessionData[] = [
    {
        algorithm: "m.megolm.v1.aes-sha2",
        room_id: "!cLDYAnjpiQXIrSwngM:localhost:8480",
        sender_key: "C9FMqTD20C0VaGWE/aSImkimuE6HDa/RyYj5gRUg3gY",
        session_id: "iGQG5GaP1/B3dSH6zCQDQqrNuotrtQjVC7w1OsUDwbg",
        session_key:
            "AQAAAADaCbP2gdOy8jrhikjploKgSBaFSJ5rvHcziaADbwNEzeCSrfuAUlXvCvxik8kU+MfCHIi5arN2M7UM5rGKdzkHnkReoIByFkeMdbjKWk5SFpVQexcM74eDhBGj+ICkQqOgApfnEbSswrmreB0+MhHHyLStwW5fy5f8A9QW1sbPuohkBuRmj9fwd3Uh+swkA0KqzbqLa7UI1Qu8NTrFA8G4",
        sender_claimed_keys: {
            ed25519: "RSq0Xw0RR0DeqlJ/j3qrF5qbN0D96fKk8lz9kZJlG9k",
        },
        forwarding_curve25519_key_chain: [],
    },
    {
        algorithm: "m.megolm.v1.aes-sha2",
        room_id: "!cLDYAnjpiQXIrSwngM:localhost:8480",
        sender_key: "C9FMqTD20C0VaGWE/aSImkimuE6HDa/RyYj5gRUg3gY",
        session_id: "P/Jy9Tog4CMtLseeS4Fe2AEXZov3k6cibcop/uyhr78",
        session_key:
            "AQAAAAATyAVm0c9c9DW9Od72MxvfSDYoysBw3C6yMJ3bYuTmssHN7yNGm59KCtKeFp2Y5qO7lvUmwOfSTvTASUb7HViE7Lt+Bvp5WiMTJ2Pv6m+N12ihyowV5lgtKFWI18Wxd0AugMTVQRwjBK6aMobf86NXWD2hiKm3N6kWbC0PXmqV7T/ycvU6IOAjLS7HnkuBXtgBF2aL95OnIm3KKf7soa+/",
        sender_claimed_keys: {
            ed25519: "RSq0Xw0RR0DeqlJ/j3qrF5qbN0D96fKk8lz9kZJlG9k",
        },
        forwarding_curve25519_key_chain: [],
    },
];

export const MEGOLM_SESSION_DATA: IMegolmSessionData = {
        algorithm: "m.megolm.v1.aes-sha2",
        sender_key: "/Bu9e34hUClhddpf4E5gu5qEAdMY31+1A9HbiAeeQgo",
        sender_claimed_keys: {
            "ed25519": "vEjK0zoE/flKjhAbzzOePv5AWXUjzcfkKdTjLpyKuhI"
        },
        room_id: "!EclSXmduSDvVcwKLnn:example.org",
        session_id: "QYiBwpB7nf0lcLMR7T9DPaQA5ml4Mhh0WfjAWrDWyOY",
        session_key: "AQAAAAAkbP0ON4cmpKBZuUXBDlfz0iSowKc/9FYzWIQVmdQM3tk5YDUaO+9kmp0T00XImkgbKCq2CFcoaQAITVU5qqNTi04P9ntakp6A3RoLn7VCiJd9RPfwaiSMeKQakGyFotkXkaiUKcPCHgEslVo1SmnaEcKLuxn9gEueHCK3hYvwTUGIgcKQe539JXCzEe0/Qz2kAOZpeDIYdFn4wFqw1sjm",
        forwarding_curve25519_key_chain: [],
        first_known_index: 0,    
};