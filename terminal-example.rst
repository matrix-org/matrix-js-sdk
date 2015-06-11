Here is an example of a terminal app:

.. code:: javascript

    "use strict";

    var myUserId = "@example:localhost";
    var myAccessToken = "QGV4YW1wbGU6bG9jYWxob3N0.qPEvLuYfNBjxikiCjP";
    var sdk = require("matrix-js-sdk");
    var matrixClient = sdk.createClient({
        baseUrl: "http://localhost:8008",
        accessToken: myAccessToken,
        userId: myUserId
    });

    // Data structures
    var roomList = [];
    var viewingRoom = null;
    var numMessagesToShow = 20;

    // Reading from stdin
    var readline = require("readline");
    var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });
    rl.on('line', function(line) {
        if (line.indexOf("enter ") === 0 && !viewingRoom) {
            var roomIndex = line.split(" ")[1];
            viewingRoom = roomList[roomIndex];
            if (viewingRoom.getMember(myUserId).membership === "invite") {
                // join the room first
                matrixClient.joinRoom(viewingRoom.roomId).done(function() {
                    printMessages();
                }, function(err) {
                    console.log("Error: %s", err);
                });
            }
            else {
                printMessages();
            }
        }
        else if (line === "/exit" && viewingRoom) {
            viewingRoom = null;
            printRoomList();
        }
        else if (line === "/members" && viewingRoom) {
            printMemberList();
        }
        else if (viewingRoom) {
            matrixClient.sendTextMessage(viewingRoom.roomId, line).done(function() {
                console.log('\x1B[2J'); // clear console
                printMessages();
            }, function(err) {
                console.log("Error: %s", err);
            });
        }
    });
    // ==== END User input

    // show the room list after syncing.
    matrixClient.on("syncComplete", function() {
        roomList = matrixClient.getRooms();
        printRoomList();
    });

    // print incoming messages.
    matrixClient.on("Room.timeline", function(event, room, toStartOfTimeline) {
        if (toStartOfTimeline) {
            return; // don't print paginated results
        }
        if (event.getType() !== "m.room.message") {
            return; // only print messages
        }
        if (!viewingRoom || viewingRoom.roomId !== room.roomId) {
            return; // not viewing a room or viewing the wrong room.
        }
        printLine(event);
    });

    function printRoomList() {
        console.log("Room List:");
        for (var i = 0; i < roomList.length; i++) {
            console.log(
                "[%s] %s (%s members)",
                i, roomList[i].name, roomList[i].currentState.getMembers().length
            );
        }
        console.log("Enter a room by typing 'enter <index>', e.g. 'enter 5'");
        console.log("Leave a room by typing '/exit'.");
        console.log("Show a room member list by typing '/members'");
    }

    function printMessages() {
        if (!viewingRoom) {
            printRoomList();
            return;
        }
        console.log('\x1B[2J'); // clear console
        var mostRecentMessages = viewingRoom.timeline.slice(numMessagesToShow * -1);
        for (var i = 0; i < mostRecentMessages.length; i++) {
            if (mostRecentMessages[i].getType() !== "m.room.message") {
                continue;
            }
            printLine(mostRecentMessages[i]);
        }
    }

    function printMemberList() {
        if (!viewingRoom) {
            printRoomList();
            return;
        }
        var members = viewingRoom.currentState.getMembers();
        // sorted based on name.
        members.sort(function(a, b) {
            if (a.name > b.name) {
                return -1;
            }
            if (a.name < b.name) {
                return 1;
            }
            return 0;
        });
        console.log(viewingRoom.name);
        console.log(new Array(viewingRoom.name.length + 1).join("-"));
        viewingRoom.currentState.getMembers().forEach(function(member) {
            if (!member.membership) {
                return;
            }
            var membershipWithPadding = (
                member.membership + new Array(10 - member.membership.length).join(" ")
            );
            console.log("%s :: %s", membershipWithPadding, member.name);
        });
    }

    function printLine(event) {
        // TODO: Update with event.sender when implemented.
        console.log("%s :: %s", event.getSender(), event.getContent().body);
    }
       
    matrixClient.startClient(numMessagesToShow);  // messages for each room.

Output::

    Room List:
    [0] Room Invite (1 members)
    [1] Room Invite (1 members)
    [2] Room Invite (1 members)
    [3] My New Room (6 members)
    [4] @megan:localhost (2 members)
    [5] Bob (2 members)
    Enter a room by typing 'enter <index>', e.g. 'enter 5'
    Leave a room by typing '/exit'.
    Show a room member list by typing '/members'

    $ enter 5

    @megan:localhost :: ooooo
    @megan:localhost :: ello
    @example:localhost :: boo
    @megan:localhost :: hey
    @megan:localhost :: how are you
    @example:localhost :: hmm
    @example:localhost :: good
    @example:localhost :: you?
    @megan:localhost :: i'm cool

    $ ping

    @megan:localhost :: ello
    @example:localhost :: boo
    @megan:localhost :: hey
    @megan:localhost :: how are you
    @example:localhost :: hmm
    @example:localhost :: good
    @example:localhost :: you?
    @megan:localhost :: i'm cool
    @example:localhost :: ping

    $ /members

    Bob
    ---
    join      :: Bob
    join      :: @example:localhost

    $ /exit

    Room List:
    [0] Room Invite (1 members)
    [1] Room Invite (1 members)
    [2] Room Invite (1 members)
    [3] My New Room (6 members)
    [4] @megan:localhost (2 members)
    [5] Bob (2 members)
    Enter a room by typing 'enter <index>', e.g. 'enter 5'
    Leave a room by typing '/exit'.
    Show a room member list by typing '/members'

