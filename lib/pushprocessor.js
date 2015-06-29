var micromatch = require("micromatch");

module.exports = function(client) {


    var escapeRegExp = function(string){
        return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    };

    var matchingRuleFromKindSet = function(ev, kindset, device) {
        var rulekinds_in_order = ['override', 'content', 'room', 'sender', 'underride'];
        for (var ruleKindIndex = 0; ruleKindIndex < rulekinds_in_order.length; ++ruleKindIndex) {
            var kind = rulekinds_in_order[ruleKindIndex];
            var ruleset = kindset[kind];

            for (var ruleIndex = 0; ruleIndex < ruleset.length; ++ruleIndex) {
                var rule = ruleset[ruleIndex];
                if (!rule.enabled) { continue; }

                var rawrule = templateRuleToRaw(kind, rule, device);
                if (!rawrule) { continue; }

                if (ruleMatchesEvent(rawrule, ev)) {
                    rule.kind = kind;
                    return rule;
                }
            }
        }
        return null;
    };

    var templateRuleToRaw = function(kind, tprule, device) {
        var rawrule = {
            'rule_id': tprule.rule_id,
            'actions': tprule.actions,
            'conditions': []
        };
        switch (kind) {
            case 'underride':
            case 'override':
                rawrule.conditions = tprule.conditions;
                break;
            case 'room':
                if (!tprule.rule_id) { return null; }
                rawrule.conditions.push({
                    'kind': 'event_match',
                    'key': 'room_id',
                    'pattern': tprule.rule_id
                });
                break;
            case 'sender':
                if (!tprule.rule_id) { return null; }
                rawrule.conditions.push({
                    'kind': 'event_match',
                    'key': 'user_id',
                    'pattern': tprule.rule_id
                });
                break;
            case 'content':
                if (!tprule.pattern) { return null; }
                rawrule.conditions.push({
                    'kind': 'event_match',
                    'key': 'content.body',
                    'pattern': tprule.pattern
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

    var ruleMatchesEvent = function(rule, ev) {
        var ret = true;
        for (var i = 0; i < rule.conditions.length; ++i) {
            var cond = rule.conditions[i];
            ret &= eventFulfillsCondition(cond, ev);
        }
        //console.log("Rule "+rule.rule_id+(ret ? " matches" : " doesn't match"));
        return ret;
    };

    var eventFulfillsCondition = function(cond, ev) {
        var condition_functions = {
            "event_match": eventFulfillsEventMatchCondition,
            "device": eventFulfillsDeviceCondition,
            "contains_display_name": eventFulfillsDisplayNameCondition,
            "room_member_count": eventFulfillsRoomMemberCountCondition
        };
        if (condition_functions[cond.kind]) { return condition_functions[cond.kind](cond, ev); }
        return true;
    };

    var eventFulfillsRoomMemberCountCondition = function(cond, ev) {
        if (!cond.is) { return false; }

        var room = client.getRoom(ev.room_id);
        if (!room || !room.currentState || !room.currentState.members) { return false; }

        var memberCount = Object.keys(room.currentState.members).length;

        var m = cond.is.match(/^([=<>]*)([0-9]*)$/);
        if (!m) { return false; }
        var ineq = m[1];
        var rhs = parseInt(m[2]);
        if (isNaN(rhs)) { return false; }
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

    var eventFulfillsDisplayNameCondition = function(cond, ev) {
        if (!ev.content || ! ev.content.body || typeof ev.content.body != 'string') { return false; }

        var room = client.getRoom(ev.room_id);
        var displayName = room.currentState.getMember(client.credentials.userId).name;

        var pat = new RegExp("\\b"+escapeRegExp(displayName)+"\\b", 'i');
        return ev.content.body.search(pat) > -1;
    };

    var eventFulfillsDeviceCondition = function(cond, ev) {
        return false; // XXX: Allow a profile tag to be set for the web client instance
    };

    var eventFulfillsEventMatchCondition = function(cond, ev) {
        var val = valueForDottedKey(cond.key, ev);
        if (!val || typeof val != 'string') { return false; }

        // Supportting ! in globs would mean figuring out when we don't want to use things as a regex, like room IDs
        var pat = cond.pattern.replace("!", "\\!");
        
        if (cond.key == 'content.body') {
            return micromatch.contains(val, pat);
        } else {
            return micromatch.isMatch(val, pat);
        }
    };

    var valueForDottedKey = function(key, ev) {
        var parts = key.split('.');
        var val = ev;
        while (parts.length > 0) {
            var thispart = parts.shift();
            if (!val[thispart]) { return null; }
            val = val[thispart];
        }
        return val;
    };

    var matchingRuleForEventWithRulesets = function(ev, rulesets) {
        if (!rulesets) { return null; }
        if (ev.user_id == client.credentials.userId) { return null; }

        var allDevNames = Object.keys(rulesets.device);
        for (var i = 0; i < allDevNames.length; ++i) {
            var devname = allDevNames[i];
            var devrules = rulesets.device[devname];

            var matchingRule = matchingRuleFromKindSet(devrules, devname);
            if (matchingRule) { return matchingRule; }
        }
        return matchingRuleFromKindSet(ev, rulesets.global);
    };

    var actionListToActionsObject = function(actionlist) {
        var actionobj = { 'notify': false, 'tweaks': {} };
        for (var i = 0; i < actionlist.length; ++i) {
            var action = actionlist[i];
            if (action === 'notify') {
                actionobj.notify = true;
            } else if (typeof action === 'object') {
                if (action.value === undefined) { action.value = true; }
                actionobj.tweaks[action.set_tweak] = action.value;
            }
        }
        return actionobj;
    };

    var pushActionsForEventAndRulesets = function(ev, rulesets) {
        var rule = matchingRuleForEventWithRulesets(ev, rulesets);
        if (!rule) { return {}; }
        
        var actionObj = actionListToActionsObject(rule.actions);

        // Some actions are implicit in some situations: we add those here
        if (actionObj.tweaks.highlight === undefined) {
            // if it isn't specified, highlight if it's a content
            // rule but otherwise not
            actionObj.tweaks.highlight = (rule.kind == 'content');
        }

        return actionObj;
    };

    this.actionsForEvent = function(ev) {
        return pushActionsForEventAndRulesets(ev, client.pushRules);
    };
};

