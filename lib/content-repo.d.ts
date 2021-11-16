/**
 * @module content-repo
 */
/**
 * Get the HTTP URL for an MXC URI.
 * @param {string} baseUrl The base homeserver url which has a content repo.
 * @param {string} mxc The mxc:// URI.
 * @param {Number} width The desired width of the thumbnail.
 * @param {Number} height The desired height of the thumbnail.
 * @param {string} resizeMethod The thumbnail resize method to use, either
 * "crop" or "scale".
 * @param {Boolean} allowDirectLinks If true, return any non-mxc URLs
 * directly. Fetching such URLs will leak information about the user to
 * anyone they share a room with. If false, will return the emptry string
 * for such URLs.
 * @return {string} The complete URL to the content.
 */
export declare function getHttpUriForMxc(baseUrl: string, mxc: string, width: number, height: number, resizeMethod: string, allowDirectLinks?: boolean): string;
//# sourceMappingURL=content-repo.d.ts.map