import type { AppState, AssetRecord, JobRecord, ProjectRecord } from "./types.js";
export declare class StateStore {
    readonly filePath: string;
    readonly legacyJsonPath?: string;
    private readonly database;
    private queue;
    constructor(databasePath: string, legacyJsonPath?: string);
    read(): Promise<AppState>;
    update(mutator: (state: AppState) => void | Promise<void>): Promise<AppState>;
    createProject(input: {
        title: string;
        brief: string;
        durationSeconds?: number;
        aspectRatio?: string;
        language: string;
    }): Promise<ProjectRecord>;
    createJob(input: {
        projectId: string;
        operation: JobRecord["operation"];
        idempotencyKey: string;
        prompt?: string;
    }): Promise<{
        job: JobRecord;
        reused: boolean;
    }>;
    updateJob(id: string, patch: Partial<JobRecord>): Promise<JobRecord>;
    registerAsset(input: Omit<AssetRecord, "id" | "createdAt" | "updatedAt"> & {
        id?: string;
    }): Promise<AssetRecord>;
    linkFlowProject(id: string, flowProjectUrl: string): Promise<ProjectRecord>;
    health(): {
        databasePath: string;
        integrity: string;
        journalMode: string;
        schemaVersion: number;
    };
    backup(destinationPath?: string): Promise<{
        path: string;
        pages: number;
        bytes: number;
    }>;
    close(): void;
    private initialize;
    private migrateLegacyJson;
    private write;
    private recordEvent;
    private assertJobTransition;
}
