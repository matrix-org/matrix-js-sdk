import { createClient } from "../../lib";

const BASE_URL = "https://matrix.org";
const TOKEN = "accesstokengoeshere";
const USER_ID = "@username:localhost";
const DEVICE_ID = "some_device_id";

const client = createClient({
    baseUrl: BASE_URL,
    accessToken: TOKEN,
    userId: USER_ID,
    deviceId: DEVICE_ID,
});

document.querySelector("button").addEventListener("click", () => client.initRustCrypto());
