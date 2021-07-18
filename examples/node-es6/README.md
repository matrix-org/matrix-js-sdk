This is a sample script to showcase server side filtering, node es6, and a few other things.

To try it out, first edit `app.js` to configure your `baseUrl` and `room`.

Next build the example using this command:

```shell
npm install
```

Next edit and run this command for multiple users on multiple terminals:

```shell
node app user1 pass1
```

Example output (after running for three different users):

```shell
@user-1:matrix.org: hello everyone
@user-2:matrix.org: hello everyone
@user-1:matrix.org: hello @user-2:matrix.org
@user-3:matrix.org: hello everyone
@user-1:matrix.org: hello @user-3:matrix.org
@user-2:matrix.org: hello @user-3:matrix.org
@user-1:matrix.org: adios everyone
```

```shell
@user-2:matrix.org: hello everyone
@user-1:matrix.org: hello @user-2:matrix.org
@user-3:matrix.org: hello everyone
@user-2:matrix.org: hello @user-3:matrix.org
@user-1:matrix.org: hello @user-3:matrix.org
# Q: Why is this event getting repeated?
@user-2:matrix.org: hello @user-3:matrix.org
@user-1:matrix.org: adios everyone
@user-2:matrix.org: adios @user-1:matrix.org
@user-3:matrix.org: adios @user-1:matrix.org
@user-2:matrix.org: adios everyone
```

```shell
@user-3:matrix.org: hello everyone
@user-1:matrix.org: hello @user-3:matrix.org
# Sometimes one of the hello user message is missing.
# Q: How and why can this happen?
@user-2:matrix.org: hello @user-3:matrix.org
@user-1:matrix.org: adios everyone
@user-3:matrix.org: adios @user-1:matrix.org
@user-2:matrix.org: adios @user-1:matrix.org
@user-3:matrix.org: adios @user-1:matrix.org
@user-2:matrix.org: adios everyone
@user-3:matrix.org: adios @user-2:matrix.org
@user-3:matrix.org: adios everyone
```
