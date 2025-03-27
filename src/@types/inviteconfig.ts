type Rule = "allow" | "block";

export interface InviteConfigAccountData {
    /**
     * Rule exceptions for users. Takes priority over `default` and `server_exceptions`.
     */
    user_exceptions: Record<string, Rule>;
    /**
     * Rule exceptions for users. Takes priority over `default`.
     */
    server_exceptions: Record<string, Rule>;
    /**
     * The default rule for invite handling when no exceptions match.
     */
    default: Rule;
}
