/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 New Vector Ltd

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

import {escapeRegExp, globToRegexp} from "./utils";

/**
 * @module pushprocessor
 */

const RULEKINDS_IN_ORDER = ['override', 'content', 'room', 'sender', 'underride'];

/**
 * Construct a Push Processor.
 * @constructor
 * @param {Object} client The Matrix client object to use
 */
function PushProcessor(client) {
    const cachedGlobToRegex = {
        // $glob: RegExp,
    };

    const matchingRuleFromKindSet = (ev, kindset, device) => {
        for (let ruleKindIndex = 0;
                ruleKindIndex < RULEKINDS_IN_ORDER.length;
                ++ruleKindIndex) {
            const kind = RULEKINDS_IN_ORDER[ruleKindIndex];
            const ruleset = kindset[kind];

            for (let ruleIndex = 0; ruleIndex < ruleset.length; ++ruleIndex) {
                const rule = ruleset[ruleIndex];
                if (!rule.enabled) {
                    continue;
                }

                const rawrule = templateRuleToRaw(kind, rule, device);
                if (!rawrule) {
                    continue;
                }

                if (this.ruleMatchesEvent(rawrule, ev)) {
                    rule.kind = kind;
                    return rule;
                }
            }
        }
        return null;
    };

    const templateRuleToRaw = function(kind, tprule, device) {
        const rawrule = {
            'rule_id': tprule.rule_id,
            'actions': tprule.actions,
            'conditions': [],
        };
        switch (kind) {
            case 'underride':
            case 'override':
                rawrule.conditions = tprule.conditions;
                break;
            case 'room':
                if (!tprule.rule_id) {
                    return null;
                }
                rawrule.conditions.push({
                    'kind': 'event_match',
                    'key': 'room_id',
                    'value': tprule.rule_id,
                });
                break;
            case 'sender':
                if (!tprule.rule_id) {
                    return null;
                }
                rawrule.conditions.push({
                    'kind': 'event_match',
                    'key': 'user_id',
                    'value': tprule.rule_id,
                });
                break;
            case 'content':
                if (!tprule.pattern) {
                    return null;
                }
                rawrule.conditions.push({
                    'kind': 'event_match',
                    'key': 'content.body',
                    'pattern': tprule.pattern,
                });
                break;
        }
        if (device) {
            rawrule.conditions.push({
                'kind': 'device',
                'profile_tag': device,
            });
        }
        return rawrule;
    };

    const eventFulfillsCondition = function(cond, ev) {
        const condition_functions = {
            "event_match": eventFulfillsEventMatchCondition,
            "device": eventFulfillsDeviceCondition,
            "contains_display_name": eventFulfillsDisplayNameCondition,
            "room_member_count": eventFulfillsRoomMemberCountCondition,
            "sender_notification_permission": eventFulfillsSenderNotifPermCondition,
        };
        if (condition_functions[cond.kind]) {
            return condition_functions[cond.kind](cond, ev);
        }
        // unknown conditions: we previously matched all unknown conditions,
        // but given that rules can be added to the base rules on a server,
        // it's probably better to not match unknown conditions.
        return false;
    };

    const eventFulfillsSenderNotifPermCondition = function(cond, ev) {
        const notifLevelKey = cond['key'];
        if (!notifLevelKey) {
            return false;
        }

        const room = client.getRoom(ev.getRoomId());
        if (!room || !room.currentState) {
            return false;
        }

        // Note that this should not be the current state of the room but the state at
        // the point the event is in the DAG. Unfortunately the js-sdk does not store
        // this.
        return room.currentState.mayTriggerNotifOfType(notifLevelKey, ev.getSender());
    };

    const eventFulfillsRoomMemberCountCondition = function(cond, ev) {
        if (!cond.is) {
            return false;
        }

        const room = client.getRoom(ev.getRoomId());
        if (!room || !room.currentState || !room.currentState.members) {
            return false;
        }

        const memberCount = room.currentState.getJoinedMemberCount();

        const m = cond.is.match(/^([=<>]*)([0-9]*)$/);
        if (!m) {
            return false;
        }
        const ineq = m[1];
        const rhs = parseInt(m[2]);
        if (isNaN(rhs)) {
            return false;
        }
        switch (ineq) {
            case '':
            case '==':
                return memberCount == rhs;
            case '<':
                return memberCount < rhs;
            case '>':
                return memberCount > rhs;
            case '<=':
                return memberCount <= rhs;
            case '>=':
                return memberCount >= rhs;
            default:
                return false;
        }
    };

    const eventFulfillsDisplayNameCondition = function(cond, ev) {
        const content = ev.getContent();
        if (!content || !content.body || typeof content.body != 'string') {
            return false;
        }

        const room = client.getRoom(ev.getRoomId());
        if (!room || !room.currentState || !room.currentState.members ||
            !room.currentState.getMember(client.credentials.userId)) {
            return false;
        }

        const displayName = room.currentState.getMember(client.credentials.userId).name;

        // N.B. we can't use \b as it chokes on unicode. however \W seems to be okay
        // as shorthand for [^0-9A-Za-z_].
        const pat = new RegExp("(^|\\W)" + escapeRegExp(displayName) + "(\\W|$)", 'i');
        return content.body.search(pat) > -1;
    };

    const eventFulfillsDeviceCondition = function(cond, ev) {
        return false; // XXX: Allow a profile tag to be set for the web client instance
    };

    const eventFulfillsEventMatchCondition = function(cond, ev) {
        if (!cond.key) {
            return false;
        }

        const val = valueForDottedKey(cond.key, ev);
        if (!val || typeof val != 'string') {
            return false;
        }

        if (cond.value) {
            return cond.value === val;
        }

        let regex;

        if (cond.key == 'content.body') {
            regex = createCachedRegex('(^|\\W)', cond.pattern, '(\\W|$)');
        } else {
            regex = createCachedRegex('^', cond.pattern, '$');
        }

        return !!val.match(regex);
    };

    const createCachedRegex = function(prefix, glob, suffix) {
        if (cachedGlobToRegex[glob]) {
            return cachedGlobToRegex[glob];
        }
        cachedGlobToRegex[glob] = new RegExp(
            prefix + globToRegexp(glob) + suffix,
            'i', // Case insensitive
        );
        return cachedGlobToRegex[glob];
    };

    const valueForDottedKey = function(key, ev) {
        const parts = key.split('.');
        let val;

        // special-case the first component to deal with encrypted messages
        const firstPart = parts[0];
        if (firstPart == 'content') {
            val = ev.getContent();
            parts.shift();
        } else if (firstPart == 'type') {
            val = ev.getType();
            parts.shift();
        } else {
            // use the raw event for any other fields
            val = ev.event;
        }

        while (parts.length > 0) {
            const thispart = parts.shift();
            if (!val[thispart]) {
                return null;
            }
            val = val[thispart];
        }
        return val;
    };

    const matchingRuleForEventWithRulesets = function(ev, rulesets) {
        if (!rulesets || !rulesets.device) {
            return null;
        }
        if (ev.getSender() == client.credentials.userId) {
            return null;
        }

        const allDevNames = Object.keys(rulesets.device);
        for (let i = 0; i < allDevNames.length; ++i) {
            const devname = allDevNames[i];
            const devrules = rulesets.device[devname];

            const matchingRule = matchingRuleFromKindSet(devrules, devname);
            if (matchingRule) {
                return matchingRule;
            }
        }
        return matchingRuleFromKindSet(ev, rulesets.global);
    };

    const pushActionsForEventAndRulesets = function(ev, rulesets) {
        const rule = matchingRuleForEventWithRulesets(ev, rulesets);
        if (!rule) {
            return {};
        }

        const actionObj = PushProcessor.actionListToActionsObject(rule.actions);

        // Some actions are implicit in some situations: we add those here
        if (actionObj.tweaks.highlight === undefined) {
            // if it isn't specified, highlight if it's a content
            // rule but otherwise not
            actionObj.tweaks.highlight = (rule.kind == 'content');
        }

        return actionObj;
    };

    this.ruleMatchesEvent = function(rule, ev) {
        let ret = true;
        for (let i = 0; i < rule.conditions.length; ++i) {
            const cond = rule.conditions[i];
            ret &= eventFulfillsCondition(cond, ev);
        }
        //console.log("Rule "+rule.rule_id+(ret ? " matches" : " doesn't match"));
        return ret;
    };


    /**
     * Get the user's push actions for the given event
     *
     * @param {module:models/event.MatrixEvent} ev
     *
     * @return {PushAction}
     */
    this.actionsForEvent = function(ev) {
        return pushActionsForEventAndRulesets(ev, client.pushRules);
    };

    /**
     * Get one of the users push rules by its ID
     *
     * @param {string} ruleId The ID of the rule to search for
     * @return {object} The push rule, or null if no such rule was found
     */
    this.getPushRuleById = function(ruleId) {
        for (const scope of ['device', 'global']) {
            if (client.pushRules[scope] === undefined) continue;

            for (const kind of RULEKINDS_IN_ORDER) {
                if (client.pushRules[scope][kind] === undefined) continue;

                for (const rule of client.pushRules[scope][kind]) {
                    if (rule.rule_id === ruleId) return rule;
                }
            }
        }
        return null;
    };
}

/**
 * Convert a list of actions into a object with the actions as keys and their values
 * eg. [ 'notify', { set_tweak: 'sound', value: 'default' } ]
 *     becomes { notify: true, tweaks: { sound: 'default' } }
 * @param {array} actionlist The actions list
 *
 * @return {object} A object with key 'notify' (true or false) and an object of actions
 */
PushProcessor.actionListToActionsObject = function(actionlist) {
    const actionobj = { 'notify': false, 'tweaks': {} };
    for (let i = 0; i < actionlist.length; ++i) {
        const action = actionlist[i];
        if (action === 'notify') {
            actionobj.notify = true;
        } else if (typeof action === 'object') {
            if (action.value === undefined) {
                action.value = true;
            }
            actionobj.tweaks[action.set_tweak] = action.value;
        }
    }
    return actionobj;
};

/**
 * @typedef {Object} PushAction
 * @type {Object}
 * @property {boolean} notify Whether this event should notify the user or not.
 * @property {Object} tweaks How this event should be notified.
 * @property {boolean} tweaks.highlight Whether this event should be highlighted
 * on the UI.
 * @property {boolean} tweaks.sound Whether this notification should produce a
 * noise.
 */

/** The PushProcessor class. */
module.exports = PushProcessor;

