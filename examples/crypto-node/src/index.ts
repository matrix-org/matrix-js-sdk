import olm from "olm";
import fs from "fs/promises";
import credentials from "./credentials.js";

const oldFetch = fetch;

global.fetch = async function (input: RequestInfo | URL | string, init?: RequestInit): Promise<Response> {
	if (typeof input == "string" && input.charAt(0) === "/") {
		return await fs.readFile(input).then(d => new Response(d, {
			headers: { "content-type": "application/wasm" }
		}));
	}

	return await oldFetch.apply(this, [input, init]);
};

global.Olm = olm;

import * as sdk from "../../../lib/index.js";
import { logger } from "../../../lib/logger.js";
import type { MatrixClient, Room } from "../../../lib/index.js";

logger.setLevel(5);

let roomList: Room[] = [];
let viewingRoom: Room | null = null;

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

const setRoomList = (client: MatrixClient) => {
	roomList = client.getRooms();
	roomList.sort((a, b) => {
		const aEvents = a.getLiveTimeline().getEvents();
		const bEvents = b.getLiveTimeline().getEvents();

		const aMsg = aEvents[aEvents.length - 1];

		if (aMsg == null) {
			return -1;
		}

		const bMsg = bEvents[bEvents.length - 1];

		if (bMsg == null) {
			return 1;
		}

		if (aMsg.getTs() === bMsg.getTs()) {
			return 0;
		}

		return aMsg.getTs() > bMsg.getTs() ? 1 : -1;
	});
};

const fixWidth = (str: string, len: number) => {
	if (str.length === len) {
		return str;
	}

	return str.length > len ? `${str.substring(0, len - 1)}\u2026` : str.padEnd(len);
};

const printRoomList = () => {
	console.log("\nRoom List:");

	for (let i = 0; i < roomList.length; i++) {
		const events = roomList[i].getLiveTimeline().getEvents();
		const msg = events[events.length - 1];
		const dateStr = msg ? new Date(msg.getTs()).toISOString().replace(/T/, " ").replace(/\..+/, "") : "---";

		const roomName = fixWidth(roomList[i].name, 25);
		const memberCount = roomList[i].getJoinedMembers().length;

		console.log(`[${i}] ${roomName} (${memberCount} members)  ${dateStr}`);
	}
};

const client = await start();

client.on(sdk.ClientEvent.Room, () => {
	setRoomList(client);

	if (!viewingRoom) {
		printRoomList();
	}
});
