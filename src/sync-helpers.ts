/*
Copyright 2025 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { type Room, NotificationCountType } from "./models/room.ts";
import { type UnreadNotificationCounts } from "./sync-accumulator.ts";

/**
 * Updates the thread notification counts for a room based on the value of
 * `unreadThreadNotifications` from a sync response. This is used in v2 sync
 * and the same way in simplified sliding sync.
 *
 * @param room The room to update the notification counts for
 * @param isEncrypted Whether the room is encrypted
 * @param unreadThreadNotifications The value of `unread_thread_notifications` from the sync response.
 *    This may be undefined, in which case the room is updated accordingly to indicate no thread notifications.
 */
export function updateRoomThreadNotifications(
    room: Room,
    isEncrypted: boolean,
    unreadThreadNotifications: Record<string, UnreadNotificationCounts> | undefined,
): void {
    if (unreadThreadNotifications) {
        // This mirrors the logic above for rooms: take the *total* notification count from
        // the server for unencrypted rooms or is it's zero. Any threads not present in this
        // object implicitly have zero notifications, so start by clearing the total counts
        // for all such threads.
        room.resetThreadUnreadNotificationCountFromSync(Object.keys(unreadThreadNotifications));
        for (const [threadId, unreadNotification] of Object.entries(unreadThreadNotifications)) {
            if (!isEncrypted || unreadNotification.notification_count === 0) {
                room.setThreadUnreadNotificationCount(
                    threadId,
                    NotificationCountType.Total,
                    unreadNotification.notification_count ?? 0,
                );
            }

            const hasNoNotifications =
                room.getThreadUnreadNotificationCount(threadId, NotificationCountType.Highlight) <= 0;
            if (!isEncrypted || (isEncrypted && hasNoNotifications)) {
                room.setThreadUnreadNotificationCount(
                    threadId,
                    NotificationCountType.Highlight,
                    unreadNotification.highlight_count ?? 0,
                );
            }
        }
    } else {
        room.resetThreadUnreadNotificationCountFromSync();
    }
}
