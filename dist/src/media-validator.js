import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export async function validateMedia(filePath, options = {}) {
    await access(filePath);
    const ffprobe = process.env.FLOW_FFPROBE_EXECUTABLE ?? "ffprobe";
    const { stdout } = await execFileAsync(ffprobe, [
        "-v", "error", "-show_entries",
        "format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
        "-of", "json", filePath,
    ], { timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
    const probe = JSON.parse(stdout);
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    const durationSeconds = Number(probe.format?.duration ?? 0);
    const checks = [
        { name: "non_empty", passed: Number(probe.format?.size ?? 0) > 0, actual: Number(probe.format?.size ?? 0), expected: "> 0 bytes" },
        { name: "video_stream", passed: Boolean(video), actual: video?.codec_name ?? null, expected: "present" },
    ];
    if (options.requireAudio !== undefined)
        checks.push({
            name: "audio_stream", passed: options.requireAudio ? Boolean(audio) : true,
            actual: audio?.codec_name ?? null, expected: options.requireAudio ? "present" : "optional",
        });
    if (options.expectedDurationSeconds !== undefined) {
        const tolerance = options.durationToleranceSeconds ?? 0.25;
        checks.push({
            name: "duration", passed: Math.abs(durationSeconds - options.expectedDurationSeconds) <= tolerance,
            actual: durationSeconds, expected: `${options.expectedDurationSeconds} ± ${tolerance} seconds`,
        });
    }
    if (options.expectedAspectRatio && video?.width && video.height) {
        const [width, height] = options.expectedAspectRatio.split(":").map(Number);
        const expected = width / height;
        const actual = video.width / video.height;
        checks.push({ name: "aspect_ratio", passed: Math.abs(actual - expected) <= 0.02, actual: `${video.width}:${video.height}`, expected: options.expectedAspectRatio });
    }
    return {
        valid: checks.every((check) => check.passed),
        path: filePath,
        sha256: await sha256File(filePath),
        format: probe.format,
        video: video ?? null,
        audio: audio ?? null,
        durationSeconds,
        checks,
        ffprobeResolvedFromPath: !existsSync(ffprobe),
    };
}
export async function sha256File(filePath) {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    for await (const chunk of stream)
        hash.update(chunk);
    return hash.digest("hex");
}
//# sourceMappingURL=media-validator.js.map