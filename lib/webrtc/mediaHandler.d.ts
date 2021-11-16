export declare class MediaHandler {
    private audioInput;
    private videoInput;
    private userMediaStreams;
    private screensharingStreams;
    /**
     * Set an audio input device to use for MatrixCalls
     * @param {string} deviceId the identifier for the device
     * undefined treated as unset
     */
    setAudioInput(deviceId: string): void;
    /**
     * Set a video input device to use for MatrixCalls
     * @param {string} deviceId the identifier for the device
     * undefined treated as unset
     */
    setVideoInput(deviceId: string): void;
    hasAudioDevice(): Promise<boolean>;
    hasVideoDevice(): Promise<boolean>;
    /**
     * @returns {MediaStream} based on passed parameters
     */
    getUserMediaStream(audio: boolean, video: boolean): Promise<MediaStream>;
    /**
     * Stops all tracks on the provided usermedia stream
     */
    stopUserMediaStream(mediaStream: MediaStream): void;
    /**
     * @returns {MediaStream} based on passed parameters
     */
    getScreensharingStream(desktopCapturerSourceId: string): Promise<MediaStream | null>;
    /**
     * Stops all tracks on the provided screensharing stream
     */
    stopScreensharingStream(mediaStream: MediaStream): void;
    /**
     * Stops all local media tracks
     */
    stopAllStreams(): void;
    private getUserMediaContraints;
    private getScreenshareContraints;
}
//# sourceMappingURL=mediaHandler.d.ts.map