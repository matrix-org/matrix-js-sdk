/**
 * This file is responsible for setting up the globals correctly before
 * importing matrix and then exporting it.
 */

/**
 * We must import olm and assign it to the global before importing matrix.
 */
import olm from "@matrix-org/olm";

// @ts-ignore TS2322 Ignore slight olm signature mismatch.
global.Olm = olm;

/**
 * We must also override the default fetch global to use the FS module when
 * attempting to fetch the wasm since the default fetch does not support local
 * files.
 */
import fs from "fs/promises";

const oldFetch = fetch;

global.fetch = async (input: RequestInfo | URL | string, init?: RequestInit): Promise<Response> => {
	// Here we need to check if it is attempting to fetch the wasm file.
	if (typeof input == "string" && input.charAt(0) === "/") {
		const data = await fs.readFile(input);

		// Return the wasm data as a typical response.
		return new Response(data, {
			headers: { "content-type": "application/wasm" }
		});
	}

	// Since this is not fetching the wasm we can just use the old implementation.
	return await oldFetch.apply(this, [input, init]);
};

/**
 * We will increase the logger severity to reduce clutter.
 */
import { logger } from "../../../lib/logger.js";

logger.setLevel(5);

/**
 * Now we can import and export the matrix sdk.
 */
import * as sdk from "../../../lib/index.js";

export default sdk;
