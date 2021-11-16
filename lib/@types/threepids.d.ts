export declare enum ThreepidMedium {
    Email = "email",
    Phone = "msisdn"
}
export interface IThreepid {
    medium: ThreepidMedium;
    address: string;
    validated_at: number;
    added_at: number;
    bound?: boolean;
}
//# sourceMappingURL=threepids.d.ts.map