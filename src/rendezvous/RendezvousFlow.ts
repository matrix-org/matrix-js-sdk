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

export const SETUP_ADDITIONAL_DEVICE_FLOW_V1 = "org.matrix.msc3906.v1";

export const SETUP_ADDITIONAL_DEVICE_FLOW_V2 = new UnstableValue(
    "m.setup.additional_device.v2",
    "org.matrix.msc3906.setup.additional_device.v2",
);

// v1 is never included in the JSON, but we give it a name for the sake of determining the flow to use
export type RendezvousFlow =
    | typeof SETUP_ADDITIONAL_DEVICE_FLOW_V2.name
    | typeof SETUP_ADDITIONAL_DEVICE_FLOW_V2.altName
    | typeof SETUP_ADDITIONAL_DEVICE_FLOW_V1;
