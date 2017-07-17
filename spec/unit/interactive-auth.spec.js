/*
Copyright 2016 OpenMarket Ltd

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
"use strict";

import 'source-map-support/register';
import Promise from 'bluebird';
const sdk = require("../..");
const utils = require("../test-utils");

const InteractiveAuth = sdk.InteractiveAuth;
const MatrixError = sdk.MatrixError;

import expect from 'expect';

// Trivial client object to test interactive auth
// (we do not need TestClient here)
class FakeClient {
    generateClientSecret() {
        return "testcl1Ent5EcreT";
    }
}

describe("InteractiveAuth", function() {
    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
    });

    it("should start an auth stage and complete it", function(done) {
        const doRequest = expect.createSpy();
        const stateUpdated = expect.createSpy();

        const ia = new InteractiveAuth({
            matrixClient: new FakeClient(),
            doRequest: doRequest,
            stateUpdated: stateUpdated,
            authData: {
                session: "sessionId",
                flows: [
                    { stages: ["logintype"] },
                ],
                params: {
                    "logintype": { param: "aa" },
                },
            },
        });

        expect(ia.getSessionId()).toEqual("sessionId");
        expect(ia.getStageParams("logintype")).toEqual({
            param: "aa",
        });

        // first we expect a call here
        stateUpdated.andCall(function(stage) {
            console.log('aaaa');
            expect(stage).toEqual("logintype");
            ia.submitAuthDict({
                type: "logintype",
                foo: "bar",
            });
        });

        // .. which should trigger a call here
        const requestRes = {"a": "b"};
        doRequest.andCall(function(authData) {
            console.log('cccc');
            expect(authData).toEqual({
                session: "sessionId",
                type: "logintype",
                foo: "bar",
            });
            return Promise.resolve(requestRes);
        });

        ia.attemptAuth().then(function(res) {
            expect(res).toBe(requestRes);
            expect(doRequest.calls.length).toEqual(1);
            expect(stateUpdated.calls.length).toEqual(1);
        }).nodeify(done);
    });

    it("should make a request if no authdata is provided", function(done) {
        const doRequest = expect.createSpy();
        const stateUpdated = expect.createSpy();

        const ia = new InteractiveAuth({
            matrixClient: new FakeClient(),
            stateUpdated: stateUpdated,
            doRequest: doRequest,
        });

        expect(ia.getSessionId()).toBe(undefined);
        expect(ia.getStageParams("logintype")).toBe(undefined);

        // first we expect a call to doRequest
        doRequest.andCall(function(authData) {
            console.log("request1", authData);
            expect(authData).toEqual({});
            const err = new MatrixError({
                session: "sessionId",
                flows: [
                    { stages: ["logintype"] },
                ],
                params: {
                    "logintype": { param: "aa" },
                },
            });
            err.httpStatus = 401;
            throw err;
        });

        // .. which should be followed by a call to stateUpdated
        const requestRes = {"a": "b"};
        stateUpdated.andCall(function(stage) {
            expect(stage).toEqual("logintype");
            expect(ia.getSessionId()).toEqual("sessionId");
            expect(ia.getStageParams("logintype")).toEqual({
                param: "aa",
            });

            // submitAuthDict should trigger another call to doRequest
            doRequest.andCall(function(authData) {
                console.log("request2", authData);
                expect(authData).toEqual({
                    session: "sessionId",
                    type: "logintype",
                    foo: "bar",
                });
                return Promise.resolve(requestRes);
            });

            ia.submitAuthDict({
                type: "logintype",
                foo: "bar",
            });
        });

        ia.attemptAuth().then(function(res) {
            expect(res).toBe(requestRes);
            expect(doRequest.calls.length).toEqual(2);
            expect(stateUpdated.calls.length).toEqual(1);
        }).nodeify(done);
    });
});
