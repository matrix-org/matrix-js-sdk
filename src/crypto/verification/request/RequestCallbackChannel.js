/*
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

export default class RequestCallbackChannel {
    constructor(request, channel) {
        this._request = request;
        this._channel = channel;
    }

    // why did we need this again?
    get transactionId() {
        return this._channel.transactionId;
    }

    get needsDoneMessage() {
        return this._channel.needsDoneMessage;
    }

    handleEvent(event, request) {
        return this._channel.handleEvent(event, request);
    }

    completedContentFromEvent(event) {
        return this._channel.completedContentFromEvent(event);
    }

    /* creates a content object with the transaction id added to it */
    completeContent(type, content) {
        return this._channel.completeContent(type, content);
    }

    async send(type, uncompletedContent) {
        this._request.handleVerifierSend(type, uncompletedContent);
        const result = await this._channel.send(type, uncompletedContent);
        return result;
    }

    async sendCompleted(type, content) {
        this._request.handleVerifierSend(type, content);
        const result = await this._channel.sendCompleted(type, content);
        return result;
    }
}
