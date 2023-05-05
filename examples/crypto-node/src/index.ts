import olm from "olm";
import fs from "fs/promises";
import credentials from "./credentials.js";

const oldFetch = fetch;

global.fetch = async function (input: RequestInfo | URL | string, init?: RequestInit): Promise<Response> {
	if (typeof input == "string" && input.charAt(0) === "/") {
		return await fs.readFile(input).then(d => new Response(d));
	}

	return await oldFetch.apply(this, [input, init]);
};

global.Olm = olm;

import * as sdk from "../../../lib/index.js";

const startWithAccessToken = async (accessToken: string, deviceId: string) => {
	const client = sdk.createClient({
		userId: credentials.userId,
		baseUrl: credentials.baseUrl,
		accessToken,
		deviceId
	});

	await client.initCrypto();
	await client.startClient({ initialSyncLimit: 0 });

	return client;
};

const start = async () => {
	const loginClient = sdk.createClient({ baseUrl: credentials.baseUrl });

	const res = await loginClient.login("m.login.password", {
		user: credentials.userId,
		password: credentials.password
	});

	loginClient.stopClient();

	return await startWithAccessToken(res.access_token, res.device_id);
};

const client = await start();
