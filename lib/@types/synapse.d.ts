import { IdServerUnbindResult } from "./partials";
export interface ISynapseAdminWhoisResponse {
    user_id: string;
    devices: {
        [deviceId: string]: {
            sessions: {
                connections: {
                    ip: string;
                    last_seen: number;
                    user_agent: string;
                }[];
            }[];
        };
    };
}
export interface ISynapseAdminDeactivateResponse {
    id_server_unbind_result: IdServerUnbindResult;
}
//# sourceMappingURL=synapse.d.ts.map