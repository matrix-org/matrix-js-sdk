"use strict";

var myUserId = "@example:localhost";
var myAccessToken = "QGV4YW1wbGU6bG9jYWxob3N0.qPEvLuYfNBjxikiCjP";
var sdk = require("matrix-js-sdk");
var clc = require("cli-color");
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
var CLEAR_CONSOLE = '\x1B[2J';
var readline = require("readline");
var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: completer
});
rl.setPrompt("$ ");
rl.on('line', function(line) {
    if (line.trim().length === 0) {
        rl.prompt();
        return;
    }
    if (line === "/help") {
        printHelp();
        rl.prompt();
        return;
    }

    if (viewingRoom) {
        if (line === "/exit") {
            viewingRoom = null;
            printRoomList();
        }
        else if (line === "/members") {
            printMemberList(viewingRoom);
        }
        else if (line === "/roominfo") {
            printRoomInfo(viewingRoom);
        }
        else if (line === "/resend") {
            // get the oldest not sent event.
            var notSentEvent;
            for (var i = 0; i < viewingRoom.timeline.length; i++) {
                if (viewingRoom.timeline[i].status == sdk.EventStatus.NOT_SENT) {
                    notSentEvent = viewingRoom.timeline[i];
                    break;
                }
            }
            if (notSentEvent) {
                matrixClient.resendEvent(notSentEvent, viewingRoom).done(function() {
                    printMessages();
                    rl.prompt();
                }, function(err) {
                    printMessages();
                    print("/resend Error: %s", err);
                    rl.prompt();
                });
                printMessages();
                rl.prompt();
            }
        }
        else if (line.indexOf("/more ") === 0) {
            var amount = parseInt(line.split(" ")[1]) || 20;
            matrixClient.scrollback(viewingRoom, amount).done(function(room) {
                printMessages();
                rl.prompt();
            }, function(err) {
                print("/more Error: %s", err);
            });
        }
        else if (line.indexOf("/invite ") === 0) {
            var userId = line.split(" ")[1].trim();
            matrixClient.invite(viewingRoom.roomId, userId).done(function() {
                printMessages();
                rl.prompt();
            }, function(err) {
                print("/invite Error: %s", err);
            });
        }
        else {
            matrixClient.sendTextMessage(viewingRoom.roomId, line).finally(function() {
                printMessages();
                rl.prompt();
            });
            // print local echo immediately
            printMessages();
        }
    }
    else {
        if (line.indexOf("/join ") === 0) {
            var roomIndex = line.split(" ")[1];
            viewingRoom = roomList[roomIndex];
            if (viewingRoom.getMember(myUserId).membership === "invite") {
                // join the room first
                matrixClient.joinRoom(viewingRoom.roomId).done(function(room) {
                    roomList = matrixClient.getRooms();
                    viewingRoom = room;
                    printMessages();
                    rl.prompt();
                }, function(err) {
                    print("/join Error: %s", err);
                });
            }
            else {
                printMessages();
            }
        } 
    }
    rl.prompt();
});
// ==== END User input

// show the room list after syncing.
matrixClient.on("syncComplete", function() {
    roomList = matrixClient.getRooms();
    printRoomList();
    printHelp();
    rl.prompt();
});

matrixClient.on("Room", function() {
    roomList = matrixClient.getRooms();
    if (!viewingRoom) {
        printRoomList();
        rl.prompt();
    }
});

// print incoming messages.
matrixClient.on("Room.timeline", function(event, room, toStartOfTimeline) {
    if (toStartOfTimeline) {
        return; // don't print paginated results
    }
    if (!viewingRoom || viewingRoom.roomId !== room.roomId) {
        return; // not viewing a room or viewing the wrong room.
    }
    printLine(event);
});

function printRoomList() {
    print("Room List:");
    for (var i = 0; i < roomList.length; i++) {
        print(
            "[%s] %s (%s members)",
            i, roomList[i].name, roomList[i].getJoinedMembers().length
        );
    }
}

function printHelp() {
    var hlp = clc.italic;
    print("Global commands:", hlp);
    print("  '/help' : Show this help.");
    print("Room list index commands:", hlp);
    print("  '/join <index>' Join a room, e.g. '/join 5'");
    print("Room commands:", hlp);
    print("  '/exit' Return to the room list index.");
    print("  '/members' Show the room member list.");
    print("  '/invite @foo:bar' Invite @foo:bar to the room.");
    print("  '/more 15' Scrollback 15 events");
    print("  '/resend' Resend the oldest event which failed to send.");
    print("  '/roominfo' Display room info e.g. name, topic.");
}

function completer(line) {
    var completions = [
        "/help", "/join ", "/exit", "/members", "/more ", "/resend", "/invite"
    ];
    var hits = completions.filter(function(c) { return c.indexOf(line) == 0 });
    // show all completions if none found
    return [hits.length ? hits : completions, line]
}

function printMessages() {
    if (!viewingRoom) {
        printRoomList();
        return;
    }
    print(CLEAR_CONSOLE);
    var mostRecentMessages = viewingRoom.timeline;
    for (var i = 0; i < mostRecentMessages.length; i++) {
        printLine(mostRecentMessages[i]);
    }
}

function printMemberList(room) {
    var members = room.currentState.getMembers();
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
    print("Membership list for room \"%s\"", room.name);
    print(new Array(room.name.length + 28).join("-"));
    room.currentState.getMembers().forEach(function(member) {
        if (!member.membership) {
            return;
        }
        var membershipWithPadding = (
            member.membership + new Array(10 - member.membership.length).join(" ")
        );
        print(
            "%s :: %s (%s)", membershipWithPadding, member.name, 
            (member.userId === myUserId ? "Me" : member.userId)
        );
    });
}

function printRoomInfo(room) {
    var eventDict = room.currentState.events;
    var eTypeHeader = "    Event Type(state_key)    ";
    var sendHeader = "        Sender        ";
    // pad content to 100
    var restCount = (
        100 - "Content".length - " | ".length - " | ".length - 
        eTypeHeader.length - sendHeader.length
    );
    var padSide = new Array(Math.floor(restCount/2)).join(" ");
    var contentHeader = padSide + "Content" + padSide;
    print(eTypeHeader+sendHeader+contentHeader);
    print(new Array(100).join("-"));
    Object.keys(eventDict).forEach(function(eventType) {
        if (eventType === "m.room.member") { return; } // use /members instead.
        Object.keys(eventDict[eventType]).forEach(function(stateKey) {
            var typeAndKey = eventType + (
                stateKey.length > 0 ? "("+stateKey+")" : ""
            );
            var typeStr = fixWidth(typeAndKey, eTypeHeader.length);
            var event = eventDict[eventType][stateKey];
            var sendStr = fixWidth(event.getSender(), sendHeader.length);
            var contentStr = fixWidth(
                JSON.stringify(event.getContent()), contentHeader.length
            );
            print(typeStr+" | "+sendStr+" | "+contentStr);
        });
    })
}

function printLine(event) {
    var fmt;
    var name = event.sender ? event.sender.name : event.getSender();
    var time = new Date(
        event.getTs()
    ).toISOString().replace(/T/, ' ').replace(/\..+/, '');
    var separator = "<<<";
    if (event.getSender() === myUserId) {
        name = "Me";
        separator = ">>>";
        if (event.status === sdk.EventStatus.SENDING) {
            separator = "...";
            fmt = clc.xterm(8);
        }
        else if (event.status === sdk.EventStatus.NOT_SENT) {
            separator = " x ";
            fmt = clc.redBright;
        }
    }
    var body = "";

    var maxNameWidth = 15;
    if (name.length > maxNameWidth) {
        name = name.substr(0, maxNameWidth-1) + "\u2026";
    }

    if (event.getType() === "m.room.message") {
        body = event.getContent().body;
    }
    else if (event.isState()) {
        var stateName = event.getType();
        if (event.getStateKey().length > 0) {
            stateName += " ("+event.getStateKey()+")";
        }
        body = (
            "[State: "+stateName+" updated to: "+JSON.stringify(event.getContent())+"]"
        );
        separator = "---";
    }
    else {
        // random message event
        body = (
            "[Message: "+event.getType()+" Content: "+JSON.stringify(event.getContent())+"]"
        );
        separator = "---";
    }
    if (fmt) {
        print(
            "[%s] %s %s %s", fmt(time), fmt(name), fmt(separator), fmt(body)
        );
    }
    else {
        print("[%s] %s %s %s", time, name, separator, body);
    }
}

function print(str, formatter) {
    if (arguments.length == 2 && typeof arguments[1] === "function") {
        console.log(arguments[1](str));
        return;
    }
    console.log.apply(console.log, arguments);
}

function fixWidth(str, len) {
    if (str.length > len) {
        return str.substr(0, len-2) + "\u2026";
    }
    else if (str.length < len) {
        return str + new Array(len - str.length).join(" ");
    }
    return str;
}

matrixClient.startClient(numMessagesToShow);  // messages for each room.