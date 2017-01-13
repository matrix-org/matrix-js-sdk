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

let q = require("q");
let sdk = require("../..");
let utils = require("../test-utils");

let InteractiveAuth = sdk.InteractiveAuth;
let MatrixError = sdk.MatrixError;

describe("InteractiveAuth", function() {
    beforeEach(function() {
        utils.beforeEach(this); // eslint-disable-line no-invalid-this
    });

    it("should start an auth stage and complete it", function(done) {
        let doRequest = jasmine.createSpy('doRequest');
        let startAuthStage = jasmine.createSpy('startAuthStage');

        let ia = new InteractiveAuth({
            doRequest: doRequest,
            startAuthStage: startAuthStage,
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
        startAuthStage.andCallFake(function(stage) {
            expect(stage).toEqual("logintype");
            ia.submitAuthDict({
                type: "logintype",
                foo: "bar",
            });
        });

        // .. which should trigger a call here
        let requestRes = {"a": "b"};
        doRequest.andCallFake(function(authData) {
            expect(authData).toEqual({
                session: "sessionId",
                type: "logintype",
                foo: "bar",
            });
            return q(requestRes);
        });

        ia.attemptAuth().then(function(res) {
            expect(res).toBe(requestRes);
            expect(doRequest.calls.length).toEqual(1);
            expect(startAuthStage.calls.length).toEqual(1);
        }).catch(utils.failTest).done(done);
    });

    it("should make a request if no authdata is provided", function(done) {
        let doRequest = jasmine.createSpy('doRequest');
        let startAuthStage = jasmine.createSpy('startAuthStage');

        let ia = new InteractiveAuth({
            doRequest: doRequest,
            startAuthStage: startAuthStage,
        });

        expect(ia.getSessionId()).toBe(undefined);
        expect(ia.getStageParams("logintype")).toBe(undefined);

        // first we expect a call to doRequest
        doRequest.andCallFake(function(authData) {
            console.log("request1", authData);
            expect(authData).toBe(null);
            let err = new MatrixError({
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

        // .. which should be followed by a call to startAuthStage
        let requestRes = {"a": "b"};
        startAuthStage.andCallFake(function(stage) {
            expect(stage).toEqual("logintype");
            expect(ia.getSessionId()).toEqual("sessionId");
            expect(ia.getStageParams("logintype")).toEqual({
                param: "aa",
            });

            // submitAuthDict should trigger another call to doRequest
            doRequest.andCallFake(function(authData) {
                console.log("request2", authData);
                expect(authData).toEqual({
                    session: "sessionId",
                    type: "logintype",
                    foo: "bar",
                });
                return q(requestRes);
            });

            ia.submitAuthDict({
                type: "logintype",
                foo: "bar",
            });
        });

        ia.attemptAuth().then(function(res) {
            expect(res).toBe(requestRes);
            expect(doRequest.calls.length).toEqual(2);
            expect(startAuthStage.calls.length).toEqual(1);
        }).catch(utils.failTest).done(done);
    });
});
