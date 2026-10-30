export type AuthStatus = "browser_closed" | "awaiting_user_fresh_sign_in" | "login_required" | "signed_in_unconfirmed" | "ready" | "access_unavailable";
export type ProjectStage = "draft" | "planned" | "references_locked" | "script_ready" | "storyboard_ready" | "generating" | "editing" | "quality_review" | "mastered" | "paused" | "cancelled";
export interface AuthRecord {
    status: AuthStatus;
    initiatedAt?: string;
    confirmedAt?: string;
    freshLoginForProjectId?: string;
    lastUrl?: string;
    lastMessage?: string;
}
export interface ProjectRecord {
    id: string;
    flowProjectUrl?: string;
    title: string;
    brief: string;
    durationSeconds?: number;
    aspectRatio?: string;
    language: string;
    stage: ProjectStage;
    status: "active" | "paused" | "cancelled" | "complete";
    createdAt: string;
    updatedAt: string;
}
export interface JobRecord {
    id: string;
    projectId: string;
    provider: "google_flow";
    operation: "image" | "video" | "browser_action";
    idempotencyKey: string;
    prompt?: string;
    state: "draft" | "prepared" | "submitted" | "generating" | "complete" | "failed" | "paused";
    attempt: number;
    error?: string;
    providerMediaId?: string;
    providerMediaUrl?: string;
    downloadPath?: string;
    submittedAt?: string;
    completedAt?: string;
    lastObservedAt?: string;
    baselineMediaIds?: string[];
    baselineFailureCount?: number;
    createdAt: string;
    updatedAt: string;
}
export interface AssetRecord {
    id: string;
    projectId: string;
    kind: "image" | "video" | "audio" | "reference" | "other";
    role: string;
    title?: string;
    sourcePath?: string;
    providerMediaId?: string;
    providerMediaUrl?: string;
    checksum?: string;
    locked: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface AppState {
    version: 2;
    auth: AuthRecord;
    projects: ProjectRecord[];
    jobs: JobRecord[];
    assets: AssetRecord[];
}
export interface FlowMediaItem {
    tileId: string;
    providerMediaId?: string;
    title: string;
    kind: "image" | "video" | "unknown";
    href: string;
}
export interface PageInspection {
    url: string;
    title: string;
    visibleText: string;
    buttons: Array<{
        index: number;
        label: string;
        frame: number;
    }>;
    textboxes: Array<{
        index: number;
        label: string;
        multiline: boolean;
        frame: number;
    }>;
    fileInputCount: number;
    media: FlowMediaItem[];
    failureCount: number;
}
