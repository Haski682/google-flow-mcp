import type { Config } from "./config.js";
import { StateStore } from "./state.js";
import type { AuthRecord, FlowMediaItem, PageInspection } from "./types.js";
export declare class FlowBrowserAdapter {
    private readonly config;
    private readonly store;
    private context?;
    private page?;
    constructor(config: Config, store: StateStore);
    startLogin(projectId: string): Promise<AuthRecord>;
    getAuthStatus(): Promise<AuthRecord>;
    confirmLogin(input: {
        projectId: string;
        userConfirmedFreshSignIn: boolean;
        membershipConfirmed: boolean;
        creditsAvailableConfirmed: boolean;
    }): Promise<AuthRecord>;
    inspectPage(): Promise<PageInspection>;
    openFlowProject(projectUrl: string): Promise<PageInspection>;
    openMedia(input: {
        projectUrl: string;
        mediaId?: string;
        title?: string;
    }): Promise<{
        media: FlowMediaItem;
        page: PageInspection;
    }>;
    waitForMedia(input: {
        projectUrl: string;
        baselineMediaIds: string[];
        baselineFailureCount: number;
        expectedKind: "image" | "video";
        timeoutSeconds: number;
        pollIntervalSeconds: number;
    }): Promise<{
        status: "complete" | "failed" | "timeout";
        media?: FlowMediaItem;
        observations: number;
        page: PageInspection;
    }>;
    fillTextbox(input: {
        text: string;
        label?: string;
        index?: number;
    }): Promise<PageInspection>;
    uploadFile(input: {
        filePath: string;
        inputIndex?: number;
    }): Promise<PageInspection>;
    bindAssetToPrompt(input: {
        assetLabel: string;
        promptLabel: string;
    }): Promise<PageInspection>;
    clickControl(input: {
        label?: string;
        index?: number;
        allowCreditSpend: boolean;
    }): Promise<PageInspection>;
    downloadAsset(input: {
        label?: string;
        index?: number;
        destinationDir: string;
        fileName?: string;
    }): Promise<{
        path: string;
        suggestedFileName: string;
        sourceUrl: string;
    }>;
    downloadMedia(input: {
        projectUrl: string;
        mediaId?: string;
        title?: string;
        destinationDir: string;
        fileName?: string;
    }): Promise<{
        path: string;
        suggestedFileName: string;
        sourceUrl: string;
        media: FlowMediaItem;
        bytes: number;
    }>;
    close(): Promise<void>;
    private ensurePage;
    private inspectMedia;
    private findMedia;
    private saveDownload;
    private validateFlowProjectUrl;
    private detectAuthentication;
    private visibleControls;
    private controlLabel;
    private visibleExactText;
    private chooseControl;
}
