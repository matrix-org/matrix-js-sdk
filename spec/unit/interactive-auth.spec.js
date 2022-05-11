/*
Copyright 2016 OpenMarket Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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

import { logger } from "../../src/logger";
import { InteractiveAuth } from "../../src/interactive-auth";
import { MatrixError } from "../../src/http-api";
import { sleep } from "../../src/utils";
import { randomString } from "../../src/randomstring";

// Trivial client object to test interactive auth
// (we do not need TestClient here)
class FakeClient {
    generateClientSecret() {
        return "testcl1Ent5EcreT";
    }
}

describe("InteractiveAuth", function() {
    it("should start an auth stage and complete it", function() {
        const doRequest = jest.fn();
        const stateUpdated = jest.fn();

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
        stateUpdated.mockImplementation(function(stage) {
            logger.log('aaaa');
            expect(stage).toEqual("logintype");
            ia.submitAuthDict({
                type: "logintype",
                foo: "bar",
            });
        });

        // .. which should trigger a call here
        const requestRes = { "a": "b" };
        doRequest.mockImplementation(function(authData) {
            logger.log('cccc');
            expect(authData).toEqual({
                session: "sessionId",
                type: "logintype",
                foo: "bar",
            });
            return Promise.resolve(requestRes);
        });

        return ia.attemptAuth().then(function(res) {
            expect(res).toBe(requestRes);
            expect(doRequest).toBeCalledTimes(1);
            expect(stateUpdated).toBeCalledTimes(1);
        });
    });

    it("should make a request if no authdata is provided", function() {
        const doRequest = jest.fn();
        const stateUpdated = jest.fn();

        const ia = new InteractiveAuth({
            matrixClient: new FakeClient(),
            stateUpdated: stateUpdated,
            doRequest: doRequest,
        });

        expect(ia.getSessionId()).toBe(undefined);
        expect(ia.getStageParams("logintype")).toBe(undefined);

        // first we expect a call to doRequest
        doRequest.mockImplementation(function(authData) {
            logger.log("request1", authData);
            expect(authData).toEqual(null); // first request should be null
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
        const requestRes = { "a": "b" };
        stateUpdated.mockImplementation(function(stage) {
            expect(stage).toEqual("logintype");
            expect(ia.getSessionId()).toEqual("sessionId");
            expect(ia.getStageParams("logintype")).toEqual({
                param: "aa",
            });

            // submitAuthDict should trigger another call to doRequest
            doRequest.mockImplementation(function(authData) {
                logger.log("request2", authData);
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

        return ia.attemptAuth().then(function(res) {
            expect(res).toBe(requestRes);
            expect(doRequest).toBeCalledTimes(2);
            expect(stateUpdated).toBeCalledTimes(1);
        });
    });

    it("should start an auth stage and reject if no auth flow", function() {
        const doRequest = jest.fn();
        const stateUpdated = jest.fn();

        const ia = new InteractiveAuth({
            matrixClient: new FakeClient(),
            doRequest: doRequest,
            stateUpdated: stateUpdated,
        });

        doRequest.mockImplementation(function(authData) {
            logger.log("request1", authData);
            expect(authData).toEqual(null); // first request should be null
            const err = new MatrixError({
                session: "sessionId",
                flows: [],
                params: {
                    "logintype": { param: "aa" },
                },
            });
            err.httpStatus = 401;
            throw err;
        });

        return ia.attemptAuth().catch(function(error) {
            expect(error.message).toBe('No appropriate authentication flow found');
        });
    });

    describe("requestEmailToken", () => {
        it("increases auth attempts", async () => {
            const doRequest = jest.fn();
            const stateUpdated = jest.fn();
            const requestEmailToken = jest.fn();
            requestEmailToken.mockImplementation(async () => ({ sid: "" }));

            const ia = new InteractiveAuth({
                matrixClient: new FakeClient(),
                doRequest, stateUpdated, requestEmailToken,
            });

            await ia.requestEmailToken();
            expect(requestEmailToken).toHaveBeenLastCalledWith(undefined, ia.getClientSecret(), 1, undefined);
            requestEmailToken.mockClear();
            await ia.requestEmailToken();
            expect(requestEmailToken).toHaveBeenLastCalledWith(undefined, ia.getClientSecret(), 2, undefined);
            requestEmailToken.mockClear();
            await ia.requestEmailToken();
            expect(requestEmailToken).toHaveBeenLastCalledWith(undefined, ia.getClientSecret(), 3, undefined);
            requestEmailToken.mockClear();
            await ia.requestEmailToken();
            expect(requestEmailToken).toHaveBeenLastCalledWith(undefined, ia.getClientSecret(), 4, undefined);
            requestEmailToken.mockClear();
            await ia.requestEmailToken();
            expect(requestEmailToken).toHaveBeenLastCalledWith(undefined, ia.getClientSecret(), 5, undefined);
        });

        it("increases auth attempts", async () => {
            const doRequest = jest.fn();
            const stateUpdated = jest.fn();
            const requestEmailToken = jest.fn();
            requestEmailToken.mockImplementation(async () => ({ sid: "" }));

            const ia = new InteractiveAuth({
                matrixClient: new FakeClient(),
                doRequest, stateUpdated, requestEmailToken,
            });

            await ia.requestEmailToken();
            expect(requestEmailToken).toHaveBeenLastCalledWith(undefined, ia.getClientSecret(), 1, undefined);
            requestEmailToken.mockClear();
            await ia.requestEmailToken();
            expect(requestEmailToken).toHaveBeenLastCalledWith(undefined, ia.getClientSecret(), 2, undefined);
            requestEmailToken.mockClear();
            await ia.requestEmailToken();
            expect(requestEmailToken).toHaveBeenLastCalledWith(undefined, ia.getClientSecret(), 3, undefined);
            requestEmailToken.mockClear();
            await ia.requestEmailToken();
            expect(requestEmailToken).toHaveBeenLastCalledWith(undefined, ia.getClientSecret(), 4, undefined);
            requestEmailToken.mockClear();
            await ia.requestEmailToken();
            expect(requestEmailToken).toHaveBeenLastCalledWith(undefined, ia.getClientSecret(), 5, undefined);
        });

        it("passes errors through", async () => {
            const doRequest = jest.fn();
            const stateUpdated = jest.fn();
            const requestEmailToken = jest.fn();
            requestEmailToken.mockImplementation(async () => {
                throw new Error("unspecific network error");
            });

            const ia = new InteractiveAuth({
                matrixClient: new FakeClient(),
                doRequest, stateUpdated, requestEmailToken,
            });

            expect(async () => await ia.requestEmailToken()).rejects.toThrowError("unspecific network error");
        });

        it("only starts one request at a time", async () => {
            const doRequest = jest.fn();
            const stateUpdated = jest.fn();
            const requestEmailToken = jest.fn();
            requestEmailToken.mockImplementation(() => sleep(500, { sid: "" }));

            const ia = new InteractiveAuth({
                matrixClient: new FakeClient(),
                doRequest, stateUpdated, requestEmailToken,
            });

            await Promise.all([ia.requestEmailToken(), ia.requestEmailToken(), ia.requestEmailToken()]);
            expect(requestEmailToken).toHaveBeenCalledTimes(1);
        });

        it("stores result in email sid", async () => {
            const doRequest = jest.fn();
            const stateUpdated = jest.fn();
            const requestEmailToken = jest.fn();
            const sid = randomString(24);
            requestEmailToken.mockImplementation(() => sleep(500, { sid }));

            const ia = new InteractiveAuth({
                matrixClient: new FakeClient(),
                doRequest, stateUpdated, requestEmailToken,
            });

            await ia.requestEmailToken();
            expect(ia.getEmailSid()).toEqual(sid);
        });
    });
});
