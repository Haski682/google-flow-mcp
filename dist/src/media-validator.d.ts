export interface MediaValidationOptions {
    expectedDurationSeconds?: number;
    durationToleranceSeconds?: number;
    expectedAspectRatio?: string;
    requireAudio?: boolean;
}
export declare function validateMedia(filePath: string, options?: MediaValidationOptions): Promise<{
    valid: boolean;
    path: string;
    sha256: string;
    format: {
        format_name?: string;
        duration?: string;
        size?: string;
        bit_rate?: string;
    } | undefined;
    video: {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        sample_rate?: string;
        channels?: number;
    } | null;
    audio: {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        sample_rate?: string;
        channels?: number;
    } | null;
    durationSeconds: number;
    checks: {
        name: string;
        passed: boolean;
        actual: unknown;
        expected?: unknown;
    }[];
    ffprobeResolvedFromPath: boolean;
}>;
export declare function sha256File(filePath: string): Promise<string>;
