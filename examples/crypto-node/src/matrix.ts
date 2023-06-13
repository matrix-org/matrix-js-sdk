/**
 * This file contains methods to help perform various actions through the matrix
 * sdk.
 */

 import { LocalStorage } from 'node-localstorage';
 import { LocalStorageCryptoStore } from "../node_modules/matrix-js-sdk/lib/crypto/store/localStorage-crypto-store.js";
 import { MemoryStore } from "../node_modules/matrix-js-sdk/lib/store/memory.js";


import sdk from "./matrix-importer.js";
import type { ICreateClientOpts, MatrixClient, Room } from "matrix-js-sdk";

// Setup the local stores.
const localStorage = new LocalStorage("./localstorage");
const cryptoStore = new LocalStorageCryptoStore(localStorage);
const store = new MemoryStore({ localStorage });

/**
 * This interface provides the details needed to perform a password login.
 */
export interface PasswordLogin {
	baseUrl: string
	userId: string
	password: string
}

/**
 * This interface provide the details needed to perform a token login.
 */
export interface TokenLogin {
	baseUrl: string
	userId: string
	accessToken: string
	deviceId: string
}

/**
 * Create a matrix client using a token login.
 */
export const startWithToken = async (tokenLogin: TokenLogin | ICreateClientOpts): Promise<MatrixClient> => {
	// If tokenLogin does not include store or cryptoStore parameters the client
	// will use the default in-memory ones.
	const client = sdk.createClient({
		...tokenLogin,
		store,
		cryptoStore
	});

	// We must initialize the crypto before starting the client.
	await client.initCrypto();

	// Now that crypto is initialized we can start the client.
	await client.startClient({ initialSyncLimit: 20 });

	// Wait until it finishes syncing.
	const state: string = await new Promise(resolve => client.once(sdk.ClientEvent.Sync, resolve));

	// If we do not recieve the correct state something has gone wrong.
	if (state !== "PREPARED") {
		throw new Error("Sync failed.");
	}

	return client;
};

/**
 * Get the access token and other details needed to perform a token login.
 */
export const getTokenLogin = async (passwordLogin: PasswordLogin): Promise<TokenLogin> => {
	// Create a dummy client pointing to the right homeserver.
	const loginClient = sdk.createClient({ baseUrl: passwordLogin.baseUrl });

	// Perform a password login.
	const response = await loginClient.login(sdk.AuthType.Password, {
		user: passwordLogin.userId,
		password: passwordLogin.password
	});

	// Stop the client now that we have got the access token.
	loginClient.stopClient();

	return {
		baseUrl: passwordLogin.baseUrl,
		userId: passwordLogin.userId,
		accessToken: response.access_token,
		deviceId: response.device_id
	};
};

/**
 * Clear all devices associated with this account except for the one currently
 * in use.
 */
export const clearDevices = async (client: MatrixClient) => {
	const devices = await client.getDevices();

	const devicesIds = devices.devices
		.map(device => device.device_id)
		.filter(id => id !== client.getDeviceId());

	await Promise.all(devicesIds.map(id => client.deleteDevice(id)));
};

/**
 * Start the client with a password login.
 */
export const start = async (passwordLogin: PasswordLogin): Promise<MatrixClient> => {
	// Get the token login details.
	const tokenLogin = await getTokenLogin(passwordLogin);

	// Start the client with the token.
	// Here we are not adding a store or a cryptoStore to the tokenLogin so the
	// client will default to the in-memory one.
	const client = await startWithToken(tokenLogin);

	return client;
}

/**
 * Mark a device associated with a user as verified.
 */
export const verifyDevice = async (client: MatrixClient, userId: string, deviceId: string): Promise<void> => {
	await client.setDeviceKnown(userId, deviceId);
	await client.setDeviceVerified(userId, deviceId);
};

/**
 * Verify all unverified devices in a room.
 */
export const verifyRoom = async (client: MatrixClient, room: Room): Promise<void> => {
	const members = await room.getEncryptionTargetMembers();
	const verificationPromises: Promise<void>[] = [];

	const crypto = client.getCrypto();

	if (crypto == null) {
		return;
	}

	const deviceMap = await crypto.getUserDeviceInfo(members.map(m => m.userId));

	for (const [member, devices] of deviceMap.entries()) {
		for (const device of devices.values()) {
			if (!device.verified) {
				verificationPromises.push( verifyDevice(client, member, device.deviceId) );
			}
		}
	}

	await Promise.all(verificationPromises);
};

/**
 * Get a sorted list of rooms.
 */
export const getRoomList = (client: MatrixClient): Room[] => {
	const rooms = client.getRooms();

	rooms.sort((a, b) => {
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

	return rooms;
};
