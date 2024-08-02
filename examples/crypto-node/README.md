## About

This is a functional terminal app which allows you to see the room list for a user, join rooms, send messages and view room membership lists with E2EE enabled.

## Install

To try it out, you will need to create a credentials file: `credentials.json` in the root of this example folder and configure it for your `homeserver`, `access_token` and `user_id` like so:

```json
{
	"userId": "@my_user:matrix.org",
	"password": "my_password",
	"baseUrl": "https://matrix.org"
}
```

You may also copy `credentials.template.json` to `credentials.json` and just edit the fields.

You then can install dependencies and build the example.
```
 $ npm install
 $ npm run build
```

## Usage
You can run the exmaple by running the following command:

```
$ node lib/index.js
```

Once it starts up you can list commands by typing:

```
/help
```

If you have trouble with encryption errors caused by devices with broken olm sessions (Usually occurring from use of the in-memory crypto store.) you can delete them all by running:

```
/cleardevices
```

This will delete all the devices on the account (except for the current one) so be careful if you have devices you do not wish to lose.

## Limitations

This example does not provide any way of verifying your sessions, so on some clients, users in the room will get a warning that someone is using an unverified session.

This example relies on the `node-localstorage` package to provide persistance which is more or less required for E2EE and at the time of writing there are no working alternative packages.

## Structure

The structure of this example has been split into separate files that deal with specific logic.

If you want to know how to import the Matrix SDK, have a look at `matrix-importer.ts`. If you want to know how to use the Matrix SDK, take a look at `matrix.ts`. If you want to know how to read the state, the `io.ts` file has a few related methods for things like printing rooms or messages. Finally the `index.ts` file glues a lot of these methods together to turn it into a small Matrix messaging client.

### matrix-importer.ts

This file is responsible for setting up the globals needed to enable E2EE on Matrix and importing the Matrix SDK correctly. This file then exports the Matrix SDK for ease of use.

### matrix.ts

This file provides a few methods to assist with certain actions through the Matrix SDK, such as logging in, verifying devices, clearing devices and getting rooms.

* `getTokenLogin` - This method logs in via password to obtain an access token and device ID.
* `startWithToken` - This method uses an access token to log into the user's account, starts the client and initializes crypto.
* `clearDevices` - This method deletes the devices (other than the current one) from the user's account.

### io.ts

This file is responsible for handling the input and output to the console and reading credentials from a file.

### index.ts

This file handles the application setup and requests input from the user. This file essentially glues the methods from `matrix.ts` and `io.ts` together to turn it into a console messaging application.
