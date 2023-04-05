/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { UnstableValue } from "../NamespacedValue";

/**
 * A rendezvous flow which allows a user to set up a new device with the help of an existing device.
 * It is described in [MSC3906](https://github.com/matrix-org/matrix-spec-proposals/pull/3906)
 */
export const SETUP_ADDITIONAL_DEVICE_FLOW = new UnstableValue(
    "m.setup.additional_device",
    "org.matrix.msc3906.setup.additional_device.v2",
);

/**
 * Used to represent an older "v1" revision of the MSC3906 rendezvous flow to setup a new device.
 *
 * @deprecated Use MSC3906 v2 using {@link SETUP_ADDITIONAL_DEVICE_FLOW} instead.
 */
export const SETUP_ADDITIONAL_DEVICE_FLOW_V1 = "org.matrix.msc3906.v1";

/**
 * Used to identify a rendezvous flow that is being used. The identifier is transmitted in a QR code or
 * some other mechanism that is convenient to the user.
 */
export type RendezvousFlow =
    | typeof SETUP_ADDITIONAL_DEVICE_FLOW.name
    | typeof SETUP_ADDITIONAL_DEVICE_FLOW.altName
    // v1 is never included in the JSON, but we give it a name for the sake of determining the flow to use
    | typeof SETUP_ADDITIONAL_DEVICE_FLOW_V1;
