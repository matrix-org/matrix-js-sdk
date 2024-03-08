/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { MsgType } from "../@types/event";

/**
 * Information on encrypted media attachments.
 *
 * Used within `m.room.message` events that reference files, such as `m.file` and `m.image`.
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#extensions-to-mroommessage-msgtypes
 */
export interface EncryptedFile {
    /**
     * The URL to the file.
     */
    url: string;
    /**
     * A JSON Web Key object.
     */
    key: {
        alg: string;
        key_ops: string[]; // eslint-disable-line camelcase
        kty: string;
        k: string;
        ext: boolean;
    };
    /**
     * The 128-bit unique counter block used by AES-CTR, encoded as unpadded base64.
     */
    iv: string;
    /**
     * A map from an algorithm name to a hash of the ciphertext, encoded as unpadded base64.
     * Clients should support the SHA-256 hash, which uses the key `sha256`.
     */
    hashes: { [alg: string]: string };
    /**
     * Version of the encrypted attachment's protocol. Must be `v2`.
     */
    v: string;
}

interface ThumbnailInfo {
    /**
     * The mimetype of the image, e.g. image/jpeg.
     */
    mimetype?: string;
    /**
     * The intended display width of the image in pixels.
     * This may differ from the intrinsic dimensions of the image file.
     */
    w?: number;
    /**
     * The intended display height of the image in pixels.
     * This may differ from the intrinsic dimensions of the image file.
     */
    h?: number;
    /**
     * Size of the image in bytes.
     */
    size?: number;
}

interface BaseInfo {
    mimetype?: string;
    size?: number;
}

/**
 * Information on media attachments of msgtype `m.file`
 *
 * Used within `m.room.message` events that reference files.
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#mfile
 */
export interface FileInfo extends BaseInfo {
    /**
     * Information on the encrypted thumbnail file, as specified in End-to-end encryption.
     * Only present if the thumbnail is encrypted.
     * @see https://spec.matrix.org/v1.9/client-server-api/#sending-encrypted-attachments
     */
    thumbnail_file?: EncryptedFile;
    /**
     * Metadata about the image referred to in thumbnail_url.
     */
    thumbnail_info?: ThumbnailInfo;
    /**
     * The URL to the thumbnail of the file. Only present if the thumbnail is unencrypted.
     */
    thumbnail_url?: string;
}

/**
 * Information on media attachments of msgtype `m.image`
 *
 * Used within `m.room.message` events that reference images.
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#mimage
 */
export interface ImageInfo extends FileInfo, ThumbnailInfo {}

/**
 * Information on media attachments of msgtype `m.audio`
 *
 * Used within `m.room.message` events that reference audio files.
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#maudio
 */
export interface AudioInfo extends BaseInfo {
    /**
     * The duration of the audio in milliseconds.
     */
    duration?: number;
}

/**
 * Information on media attachments of msgtype `m.video`
 *
 * Used within `m.room.message` events that reference video files.
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#mvideo
 */
export interface VideoInfo extends AudioInfo, ImageInfo {
    /**
     * The duration of the video in milliseconds.
     */
    duration?: number;
}

/**
 * Union type representing the `content.info` field of all specified media events.
 */
export type MediaEventInfo = FileInfo | ImageInfo | AudioInfo | VideoInfo;

interface BaseContent {
    /**
     * Required if the file is encrypted. Information on the encrypted file, as specified in End-to-end encryption.
     * @see https://spec.matrix.org/v1.9/client-server-api/#sending-encrypted-attachments
     */
    file?: EncryptedFile;
    /**
     * Required if the file is unencrypted. The URL (typically mxc:// URI) to the file.
     */
    url?: string;
}

/**
 * Content format of media events with msgtype `m.file`
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#mfile
 */
export interface FileContent extends BaseContent {
    /**
     * A human-readable description of the file.
     * This is recommended to be the filename of the original upload.
     */
    body: string;
    /**
     * The original filename of the uploaded file.
     */
    filename?: string;
    /**
     * Information about the file referred to in url.
     */
    info?: FileInfo;
    /**
     * One of: [m.file].
     */
    msgtype: MsgType.File;
}

/**
 * Content format of media events with msgtype `m.image`
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#mimage
 */
export interface ImageContent extends BaseContent {
    /**
     * A textual representation of the image.
     * This could be the alt text of the image, the filename of the image,
     * or some kind of content description for accessibility e.g. ‘image attachment’.
     */
    body: string;
    /**
     * Metadata about the image referred to in url.
     */
    info?: ImageInfo;
    /**
     * One of: [m.image].
     */
    msgtype: MsgType.Image;
}

/**
 * Content format of media events with msgtype `m.audio`
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#maudio
 */
export interface AudioContent extends BaseContent {
    /**
     * A description of the audio e.g. ‘Bee Gees - Stayin’ Alive’,
     * or some kind of content description for accessibility e.g. ‘audio attachment’.
     */
    body: string;
    /**
     * Metadata for the audio clip referred to in url.
     */
    info?: AudioInfo;
    /**
     * One of: [m.audio].
     */
    msgtype: MsgType.Audio;
}

/**
 * Content format of media events with msgtype `m.video`
 *
 * @see https://spec.matrix.org/v1.9/client-server-api/#mvideo
 */
export interface VideoContent extends BaseContent {
    /**
     * A description of the video e.g. ‘Gangnam style’,
     * or some kind of content description for accessibility e.g. ‘video attachment’.
     */
    body: string;
    /**
     * Metadata about the video clip referred to in url.
     */
    info?: VideoInfo;
    /**
     * One of: [m.video].
     */
    msgtype: MsgType.Video;
}

/**
 * Type representing media event contents for `m.room.message` events listed in the Matrix specification
 */
export type MediaEventContent = FileContent | ImageContent | AudioContent | VideoContent;
