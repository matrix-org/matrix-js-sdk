/*
Copyright 2018 New Vector Ltd
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

// ideally the verifier would be part of the VerificationRequest,
// or at least the scope of the verifier would be smaller
// but we need to know from the request when the verifier cancels,
// so we can clean up and update the UI.
// TBD if this will be needed
export default class ProxyMedium {
    constructor(request, medium) {
        this._request = request;
        this._medium = medium;
    }

    // why did we need this again?
    get transactionId() {
        return this._medium.transactionId;
    }

    get needsDoneMessage() {
        return this._medium.needsDoneMessage;
    }

    handleEvent(event, request) {
        return this._medium.handleEvent(event, request);
    }

    completedContentFromEvent(event) {
        return this._medium.completedContentFromEvent(event);
    }

    /* creates a content object with the transaction id added to it */
    completeContent(type, content) {
        return this._medium.completeContent(type, content);
    }

    async send(type, uncompletedContent) {
        this._request.handleVerifierSend(type, uncompletedContent);
        const result = await this._medium.send(type, uncompletedContent);
        return result;
    }

    async sendCompleted(type, content) {
        this._request.handleVerifierSend(type, content);
        const result = await this._medium.sendCompleted(type, content);
        return result;
    }
}
