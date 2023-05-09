This is a functional terminal app which allows you to see the room list for a user, join rooms, send messages and view room membership lists.


## Install

To try it out, you will need to create a credentials file: `crednetials.json` in the root of this example folder and configure it for your `homeserver`, `access_token` and `user_id` like so:

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

If you have trouble with encryption errors cause by old devices you can delete them all by running:

```
/cleardevices
```

This will delete all the devices on the account (except for the current one) so be careful if you have devices you do not wish to lose.
