import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
const FLOW_URL = "https://labs.google/fx/tools/flow";
const CREDIT_ACTION = /^(generate|create|生成|制作|产生)(\s|$)/i;
const BLOCKED_AUTH_ACTION = /(password|passkey|verification|验证码|验证|sign\s*out|log\s*out|退出登录|登出)/i;
export class FlowBrowserAdapter {
    config;
    store;
    browser;
    context;
    page;
    constructor(config, store) {
        this.config = config;
        this.store = store;
    }
    async startLogin(projectId) {
        const state = await this.store.read();
        if (!state.projects.some((project) => project.id === projectId))
            throw new Error(`Project not found: ${projectId}`);
        // El Chrome es compartido por CDP: el usuario inicia sesión en una pestaña de este
        // mismo navegador y no hace falta cerrarlo antes de confirmar.
        const page = await this.ensurePage();
        await page.goto(FLOW_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
        await page.bringToFront().catch(() => undefined);
        const next = await this.store.update((draft) => {
            draft.auth = {
                status: "awaiting_user_fresh_sign_in",
                initiatedAt: new Date().toISOString(),
                lastUrl: FLOW_URL,
                lastMessage: "Sign in to Google Flow personally in the open Chrome window (no need to close it afterwards), then ask the AI to confirm login. Never send passwords or verification codes to the AI.",
            };
        });
        return next.auth;
    }
    async getAuthStatus() {
        if (!this.context || !this.page || this.page.isClosed())
            return (await this.store.read()).auth;
        const detected = await this.detectAuthentication();
        const state = await this.store.read();
        const status = detected === "login_required" ? "login_required" : state.auth.status === "ready" ? "ready" : "signed_in_unconfirmed";
        const next = await this.store.update((draft) => {
            draft.auth.status = status;
            draft.auth.lastUrl = this.page.url();
            draft.auth.lastMessage = status === "login_required"
                ? "请在可见浏览器中完成 Google 登录。"
                : status === "ready" ? "登录检查点已完成。" : "浏览器已登录；仍需用户确认全新登录、会员资格和可用额度。";
        });
        return next.auth;
    }
    async confirmLogin(input) {
        if (!input.userConfirmedFreshSignIn)
            throw new Error("Fresh sign-in must be completed and confirmed by the user.");
        if (!input.membershipConfirmed || !input.creditsAvailableConfirmed) {
            throw new Error("Google Flow membership/access and usable credits must be confirmed before generation.");
        }
        const state = await this.store.read();
        if (!state.projects.some((project) => project.id === input.projectId))
            throw new Error(`Project not found: ${input.projectId}`);
        try {
            const page = await this.ensurePage();
            if (!page.url().startsWith(FLOW_URL))
                await page.goto(FLOW_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
            if ((await this.detectAuthentication()) === "login_required")
                throw new Error("Google still shows a login page. Complete login in the normal Chrome window first.");
        }
        catch (error) {
            if (/profile.*in use|processsingleton|user data directory.*in use|singletonlock/i.test(error.message)) {
                throw new Error(`A Chrome using the dedicated Flow profile is running without the shared debugging port ${this.config.cdpPort}. Close all its windows once, then retry.`, { cause: error });
            }
            throw error;
        }
        const next = await this.store.update((draft) => {
            draft.auth.status = "ready";
            draft.auth.confirmedAt = new Date().toISOString();
            draft.auth.freshLoginForProjectId = input.projectId;
            draft.auth.lastUrl = this.page?.url();
            draft.auth.lastMessage = "Fresh login, membership/access, and usable credits were user-confirmed.";
        });
        return next.auth;
    }
    async inspectPage() {
        const page = await this.ensurePage();
        const buttons = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1']), summary, input[type='button'], input[type='submit']");
        const textboxes = await this.visibleControls("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
        let fileInputCount = 0;
        for (const frame of page.frames())
            fileInputCount += await frame.locator("input[type='file']").count();
        const bodyText = await page.locator("body").innerText().catch(() => "");
        return {
            url: page.url(),
            title: await page.title(),
            visibleText: bodyText.replace(/\s+/g, " ").trim().slice(0, 12_000),
            buttons: buttons.slice(0, 120).map((control, index) => ({ index, label: control.label, frame: control.frame })),
            textboxes: await Promise.all(textboxes.slice(0, 40).map(async (control, index) => ({
                index,
                label: control.label,
                multiline: await control.locator.evaluate((element) => element.tagName === "TEXTAREA" || element.getAttribute("aria-multiline") === "true"),
                frame: control.frame,
            }))),
            fileInputCount,
            media: (await this.inspectMedia()).slice(0, 12).map(({ tileId, kind, title }) => ({ tileId, kind, title: title.slice(0, 60) })), // compact: full data via findMedia
            failureCount: (bodyText.match(/\bwarning\s+Failed\b|生成失败/gi) ?? []).length,
        };
    }
    async openFlowProject(projectUrl) {
        this.validateFlowProjectUrl(projectUrl);
        const page = await this.ensurePage();
        await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForTimeout(3_000);
        return this.inspectPage();
    }
    async openMedia(input) {
        await this.openFlowProject(input.projectUrl);
        const media = await this.findMedia(input);
        const page = await this.ensurePage();
        await page.goto(media.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.getByRole("button", { name: /Download|下载/i }).first().waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForTimeout(500);
        return { media, page: await this.inspectPage() };
    }
    async waitForMedia(input) {
        const page = await this.ensurePage();
        if (!page.url().startsWith(input.projectUrl))
            await this.openFlowProject(input.projectUrl);
        const baseline = new Set(input.baselineMediaIds);
        const deadline = Date.now() + input.timeoutSeconds * 1_000;
        let failedObservations = 0;
        let observations = 0;
        let inspection = await this.inspectPage();
        while (Date.now() <= deadline) {
            observations += 1;
            inspection = await this.inspectPage();
            const created = inspection.media.find((item) => item.kind === input.expectedKind && !baseline.has(item.tileId) && (!item.providerMediaId || !baseline.has(item.providerMediaId)));
            if (created)
                return { status: "complete", media: created, observations, page: inspection };
            failedObservations = inspection.failureCount > input.baselineFailureCount ? failedObservations + 1 : 0;
            if (failedObservations >= 3)
                return { status: "failed", observations, page: inspection };
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            await page.waitForTimeout(Math.min(input.pollIntervalSeconds * 1_000, remaining));
            await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
            await page.waitForTimeout(1_500);
        }
        return { status: "timeout", observations, page: inspection };
    }
    async fillTextbox(input) {
        const page = await this.ensurePage();
        if (new URL(page.url()).hostname === "accounts.google.com")
            throw new Error("Credential entry is user-only. Type login details directly in the visible browser.");
        const controls = await this.visibleControls("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
        const target = this.chooseControl(controls, input.label, input.index, "textbox");
        if (BLOCKED_AUTH_ACTION.test(target.label))
            throw new Error("MCP refuses to fill credential or verification fields.");
        const isRichEditor = await target.locator.evaluate((element) => element.isContentEditable && element.tagName !== "INPUT" && element.tagName !== "TEXTAREA");
        if (isRichEditor) {
            // Rich-text editors ignore programmatic fill; type through the keyboard like a user.
            await target.locator.click();
            await page.keyboard.press("Control+A");
            await page.keyboard.press("Delete");
            await page.keyboard.insertText(input.text);
        }
        else {
            await target.locator.fill(input.text);
        }
        return this.inspectPage();
    }
    async uploadFile(input) {
        const page = await this.ensurePage();
        const absolute = path.resolve(input.filePath);
        await access(absolute);
        const inputs = [];
        for (const frame of page.frames()) {
            const locator = frame.locator("input[type='file']");
            for (let index = 0; index < await locator.count(); index += 1)
                inputs.push(locator.nth(index));
        }
        if (inputs.length === 0) {
            // Flow (flow.google.com) creates the file input only on click and opens a native chooser.
            const uploadButton = page.locator("button[mattooltip*='Subir archivo'], button[mattooltip*='Upload'], button.sidebar-upload-btn").first();
            if (await uploadButton.count() === 0)
                throw new Error("No file input or upload button is currently present. Open the ingredients panel first.");
            const [chooser] = await Promise.all([
                page.waitForEvent("filechooser", { timeout: 15000 }),
                uploadButton.click({ timeout: 15000 }),
            ]);
            await chooser.setFiles(absolute);
            await page.waitForTimeout(4000);
            return this.inspectPage();
        }
        const index = input.inputIndex ?? 0;
        if (!inputs[index])
            throw new Error(`File input index ${index} does not exist.`);
        await inputs[index].setInputFiles(absolute);
        return this.inspectPage();
    }
    async bindAssetToPrompt(input) {
        const sources = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1'])");
        let source;
        try {
            source = this.chooseControl(sources, input.assetLabel, undefined, "asset");
        }
        catch (error) {
            const textMatches = await this.visibleExactText(input.assetLabel);
            if (textMatches.length !== 1)
                throw error;
            source = textMatches[0];
        }
        const prompts = await this.visibleControls("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']");
        const prompt = this.chooseControl(prompts, input.promptLabel, undefined, "prompt textbox");
        await source.locator.dragTo(prompt.locator, { timeout: 30_000 });
        await this.page?.waitForTimeout(1_500);
        return this.inspectPage();
    }
    async clickControl(input) {
        const controls = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1']), summary, input[type='button'], input[type='submit']");
        let target;
        try {
            target = this.chooseControl(controls, input.label, input.index, "button");
        }
        catch (error) {
            if (!input.label || input.index !== undefined)
                throw error;
            const textMatches = await this.visibleExactText(input.label);
            if (textMatches.length !== 1)
                throw error;
            target = textMatches[0];
        }
        if (BLOCKED_AUTH_ACTION.test(target.label))
            throw new Error("Signing out and credential-related actions are user-only.");
        if (CREDIT_ACTION.test(target.label) && !input.allowCreditSpend)
            throw new Error("This control may spend Google Flow credits. Set allowCreditSpend=true only after user approval.");
        await target.locator.click();
        await this.page?.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
        try {
            return await this.inspectPage();
        }
        catch {
            const page = await this.ensurePage();
            return { url: page.url(), title: await page.title().catch(() => ""), visibleText: "", buttons: [], textboxes: [], fileInputCount: 0, media: [], failureCount: 0 };
        }
    }
    async downloadAsset(input) {
        const page = await this.ensurePage();
        const controls = await this.visibleControls("button, [role='button'], a[href], [tabindex]:not([tabindex='-1']), summary, input[type='button'], input[type='submit']");
        let target;
        try {
            target = this.chooseControl(controls, input.label, input.index, "download control");
        }
        catch (error) {
            if (!input.label || input.index !== undefined)
                throw error;
            const textMatches = await this.visibleExactText(input.label);
            if (textMatches.length !== 1)
                throw error;
            target = textMatches[0];
        }
        const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
        await target.locator.click();
        const download = await downloadPromise;
        return this.saveDownload(download, input.destinationDir, input.fileName, page.url());
    }
    async downloadMedia(input) {
        const { media } = await this.openMedia(input);
        const page = await this.ensurePage();
        const downloadControl = page.getByRole("button", { name: /Download|下载/i }).first();
        if (!(await downloadControl.isVisible().catch(() => false)))
            throw new Error("Flow media detail page does not expose a visible Download control.");
        let download = await Promise.all([
            page.waitForEvent("download", { timeout: 10_000 }).catch(() => undefined), downloadControl.click(),
        ]).then(([value]) => value);
        if (!download) {
            const menuItem = page.getByText(/Original|Original size|原始|原图|1080p|720p/i).last();
            if (!(await menuItem.isVisible().catch(() => false)))
                throw new Error("Download menu opened, but no supported original-size item was found.");
            download = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), menuItem.click()]).then(([value]) => value);
        }
        if (!download)
            throw new Error("Flow did not produce a download.");
        const saved = await this.saveDownload(download, input.destinationDir, input.fileName, page.url());
        return { ...saved, media, bytes: (await stat(saved.path)).size };
    }
    async close() {
        // Solo se cierra la pestaña propia y se desconecta; Chrome sigue vivo para otras sesiones.
        const browser = this.browser;
        const page = this.page;
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
        await page?.close().catch(() => undefined);
        await browser?.close().catch(() => undefined);
    }
    async connectShared() {
        return chromium.connectOverCDP(`http://127.0.0.1:${this.config.cdpPort}`, { timeout: 5_000 });
    }
    async ensureBrowser() {
        if (this.browser?.isConnected() && this.context)
            return this.context;
        let browser = await this.connectShared().catch(() => undefined);
        if (!browser) {
            // Si dos sesiones lanzan Chrome a la vez, el segundo proceso cede el perfil al primero y sale.
            const chrome = spawn(this.config.browserExecutable, [
                `--user-data-dir=${this.config.profileDir}`,
                `--remote-debugging-port=${this.config.cdpPort}`,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-default-apps",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows",
            ], { detached: true, stdio: "ignore", windowsHide: false });
            chrome.unref();
            const deadline = Date.now() + 20_000;
            while (!browser && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                browser = await this.connectShared().catch(() => undefined);
            }
            if (!browser) {
                throw new Error(`Could not reach the shared Flow Chrome on port ${this.config.cdpPort}. If a Chrome using the Flow profile was opened without that port, close all its windows once and retry.`);
            }
        }
        this.browser = browser;
        this.context = browser.contexts()[0];
        this.page = undefined;
        browser.once("disconnected", () => {
            if (this.browser === browser) {
                this.browser = undefined;
                this.context = undefined;
                this.page = undefined;
            }
        });
        return this.context;
    }
    async ensurePage() {
        const context = await this.ensureBrowser();
        if (!this.page || this.page.isClosed()) {
            // Cada sesión trabaja en su propia pestaña; nunca toma las de otra sesión.
            this.page = await context.newPage();
        }
        return this.page;
    }
    async inspectMedia() {
        const page = await this.ensurePage();
        const results = [];
        for (const frame of page.frames()) {
            const tiles = frame.locator("[data-tile-id]");
            const count = Math.min(await tiles.count(), 200);
            for (let index = 0; index < count; index += 1) {
                const tile = tiles.nth(index);
                if (!(await tile.isVisible().catch(() => false)))
                    continue;
                const item = await tile.evaluate((element) => {
                    const domTileId = element.getAttribute("data-tile-id") ?? "";
                    const anchor = element.querySelector("a[href*='/fx/tools/flow/project/'][href*='/edit/']");
                    const href = anchor ? new URL(anchor.href, location.origin).toString() : "";
                    const tileId = href ? new URL(href).pathname.split("/").filter(Boolean).at(-1) ?? domTileId.replace(/^fe_id_/, "") : domTileId.replace(/^fe_id_/, "");
                    const video = element.querySelector("video");
                    const image = element.querySelector("img");
                    const source = video?.getAttribute("src") ?? image?.getAttribute("src") ?? "";
                    let providerMediaId;
                    try {
                        providerMediaId = new URL(source, location.origin).searchParams.get("name") ?? undefined;
                    }
                    catch {
                        providerMediaId = undefined;
                    }
                    const leaf = Array.from(element.querySelectorAll("div")).find((node) => {
                        const value = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
                        return value.length > 2 && node.children.length === 0 && !/^(play|play_arrow|play_circle)$/i.test(value);
                    });
                    return {
                        tileId,
                        providerMediaId,
                        title: leaf?.textContent?.replace(/\s+/g, " ").trim() ?? image?.getAttribute("alt") ?? tileId,
                        kind: video ? "video" : image ? "image" : "unknown",
                        href,
                    };
                });
                if (item.tileId && item.href)
                    results.push(item);
            }
        }
        if (results.length === 0) {
            // flow.google.com layout: no labs.google /edit/ anchors. Fall back to visible media elements in the grid.
            const fallback = await page.evaluate(() => {
                const items = [];
                const nodes = Array.from(document.querySelectorAll("img, video"));
                for (const node of nodes) {
                    const rect = node.getBoundingClientRect();
                    if (rect.width < 80 || rect.height < 80)
                        continue;
                    if (node.closest("[role='dialog'], .cdk-overlay-container"))
                        continue;
                    const source = node.currentSrc || node.getAttribute("src") || "";
                    if (!source || source.startsWith("data:"))
                        continue;
                    const anchor = node.closest("a[href]");
                    const tile = node.closest("[data-tile-id], [data-media-id], [data-id]");
                    let providerMediaId;
                    try {
                        const url = new URL(source, location.origin);
                        providerMediaId = url.searchParams.get("name") ?? url.searchParams.get("id") ?? url.pathname.split("/").filter(Boolean).at(-1) ?? undefined;
                    }
                    catch {
                        providerMediaId = undefined;
                    }
                    const domId = tile?.getAttribute("data-tile-id") ?? tile?.getAttribute("data-media-id") ?? tile?.getAttribute("data-id") ?? "";
                    const href = anchor ? new URL(anchor.href, location.origin).toString() : "";
                    if (providerMediaId)
                        providerMediaId = providerMediaId.replace(/=[a-z0-9-]+$/i, "").slice(0, 24);
                    const tileId = (domId.replace(/^fe_id_/, "") || (anchor ? new URL(anchor.href, location.origin).pathname.split("/").filter(Boolean).at(-1) : "") || providerMediaId || source).slice(0, 200);
                    const container = anchor ?? tile ?? node.parentElement;
                    const caption = container?.innerText?.replace(/\s+/g, " ").trim() ?? "";
                    items.push({
                        tileId,
                        providerMediaId,
                        title: (caption || node.getAttribute("alt") || tileId).replace(/^(image|videocam)\s+/i, "").slice(0, 200),
                        kind: node.tagName === "VIDEO" ? "video" : "image",
                        href,
                        src: new URL(source, location.origin).toString(),
                    });
                }
                return items;
            });
            results.push(...fallback);
        }
        return [...new Map(results.map((item) => [item.tileId || item.href, item])).values()];
    }
    async saveMediaSource(input) {
        // Save a media item's own image/video source with the signed-in session (no detail page needed).
        const media = await this.findMedia(input);
        const source = media.src ?? media.href;
        if (!source)
            throw new Error("Media item has no downloadable source URL.");
        const page = await this.ensurePage();
        // Grid tiles use size-limited URLs (=s512-rw). Ask for the original first (=s0 / =d), then fall back.
        const base = source.replace(/=[a-z0-9-]+$/i, "");
        const candidates = base !== source ? [`${base}=d`, `${base}=s0`, source] : [source];
        let res;
        for (const candidate of candidates) {
            res = await page.request.get(candidate, { timeout: 60_000 }).catch(() => undefined);
            if (res?.ok() && (res.headers()["content-type"] ?? "").match(/image|video|octet-stream/))
                break;
        }
        if (!res?.ok())
            throw new Error(`Media download failed with HTTP ${res?.status() ?? "error"}.`);
        const body = await res.body();
        if (body.length <= 0)
            throw new Error("Media download returned an empty body.");
        const type = res.headers()["content-type"] ?? "";
        const extension = type.includes("png") ? ".png" : type.includes("jpeg") || type.includes("jpg") ? ".jpg" : type.includes("webp") ? ".webp" : type.includes("mp4") ? ".mp4" : "";
        const destinationDir = path.resolve(input.destinationDir);
        await mkdir(destinationDir, { recursive: true });
        let name = path.basename(input.fileName);
        if (!path.extname(name) && extension)
            name += extension;
        const destination = path.join(destinationDir, name);
        const { writeFile } = await import("node:fs/promises");
        await writeFile(destination, body);
        return { path: destination, bytes: body.length, contentType: type, media };
    }
    async openTileMenu(mediaId) {
        const page = await this.ensurePage();
        const id = mediaId.replace(/["\\]/g, "");
        let tile = page.locator(`[data-tile-id="${id}"], [data-tile-id="fe_id_${id}"], [data-media-id="${id}"], [data-id="${id}"]`).first();
        if (await tile.count() === 0)
            tile = page.locator(`img[src*="${id}"], video[src*="${id}"], video[poster*="${id}"]`).first();
        if (await tile.count() === 0)
            throw new Error(`No visible Flow tile with id ${mediaId}. Use a tileId from flow_inspect_page.media.`);
        await tile.scrollIntoViewIfNeeded();
        await tile.hover();
        await page.waitForTimeout(400);
        let scope = tile;
        let moreButton = scope.locator("button").filter({ hasText: /more_vert/ }).first();
        for (let level = 0; level < 5 && await moreButton.count() === 0; level += 1) {
            scope = scope.locator("xpath=..");
            moreButton = scope.locator("button").filter({ hasText: /more_vert/ }).first();
        }
        if (await moreButton.count() === 0)
            throw new Error("Tile options (⋮) button not found after hovering the tile.");
        await moreButton.click();
        return page;
    }
    async tileMenuAction(input) {
        // Safe tile-menu actions only; destructive ("Mover a la papelera") and reporting are not allowed.
        const page = await this.openTileMenu(input.mediaId);
        const item = page.getByRole("menuitem", { name: new RegExp(input.action, "i") }).first();
        await item.waitFor({ state: "visible", timeout: 10_000 });
        await item.click();
        await page.waitForTimeout(1_000);
        return this.inspectPage();
    }
    async downloadTileAtSize(input) {
        // flow.google.com grid: tile ⋮ menu → Descargar → 1K (original) / 2K / 4K (upscaled).
        const page = await this.ensurePage();
        const id = input.mediaId.replace(/["\\]/g, "");
        let tile = page.locator(`[data-tile-id="${id}"], [data-tile-id="fe_id_${id}"], [data-media-id="${id}"], [data-id="${id}"]`).first();
        if (await tile.count() === 0)
            tile = page.locator(`img[src*="${id}"], video[src*="${id}"], video[poster*="${id}"]`).first();
        if (await tile.count() === 0)
            throw new Error(`No visible Flow tile with id ${input.mediaId}. Use a tileId from flow_inspect_page.media.`);
        await tile.scrollIntoViewIfNeeded();
        await tile.hover();
        await page.waitForTimeout(400);
        let scope = tile;
        let moreButton = scope.locator("button").filter({ hasText: /more_vert/ }).first();
        for (let level = 0; level < 5 && await moreButton.count() === 0; level += 1) {
            scope = scope.locator("xpath=..");
            moreButton = scope.locator("button").filter({ hasText: /more_vert/ }).first();
        }
        if (await moreButton.count() === 0)
            throw new Error("Tile options (⋮) button not found after hovering the tile.");
        await moreButton.click();
        const downloadItem = page.getByRole("menuitem", { name: /Descargar|Download/i }).first();
        await downloadItem.waitFor({ state: "visible", timeout: 10_000 });
        await downloadItem.hover();
        await downloadItem.click().catch(() => undefined);
        const sizeOption = page.locator("[role='menuitem'], button").filter({ hasText: new RegExp(`^\\s*${input.size}\\b`) }).first();
        await sizeOption.waitFor({ state: "visible", timeout: 10_000 });
        if (await sizeOption.isDisabled().catch(() => false))
            throw new Error(`${input.size} download is not available on this plan.`);
        // Upscaling happens server-side before the file is offered, so allow a generous wait.
        const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 300_000 }),
            sizeOption.click(),
        ]);
        let fileName = input.fileName;
        if (fileName && !path.extname(fileName))
            fileName += path.extname(download.suggestedFilename()) || ".png";
        return this.saveDownload(download, input.destinationDir, fileName, page.url());
    }
    async pressKey(key) {
        const page = await this.ensurePage();
        await page.keyboard.press(key);
        await page.waitForTimeout(500);
        return this.inspectPage();
    }
    async findMedia(input) {
        const normalizedTitle = input.title?.trim().toLocaleLowerCase();
        let lastMatches = [];
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const items = await this.inspectMedia();
            lastMatches = items.filter((item) => (input.mediaId && (item.tileId === input.mediaId || item.providerMediaId === input.mediaId)) ||
                (normalizedTitle && item.title.toLocaleLowerCase().includes(normalizedTitle)));
            if (lastMatches.length === 1)
                return lastMatches[0];
            if (lastMatches.length > 1)
                break;
            await (await this.ensurePage()).waitForTimeout(2_000);
        }
        throw new Error(`Expected one Flow media item, found ${lastMatches.length}. Inspect flow_inspect_page.media and use tileId or providerMediaId.`);
    }
    async saveDownload(download, destinationDirInput, fileName, sourceUrl) {
        const suggestedFileName = download.suggestedFilename();
        const requestedName = fileName ? path.basename(fileName) : suggestedFileName;
        if (!requestedName || requestedName === "." || requestedName === "..")
            throw new Error("Invalid download file name.");
        const destinationDir = path.resolve(destinationDirInput);
        await mkdir(destinationDir, { recursive: true });
        const destination = path.join(destinationDir, requestedName);
        try {
            await download.saveAs(destination);
        }
        catch (error) {
            await this.recoverSharedDownload(error, destination);
        }
        if ((await stat(destination)).size <= 0)
            throw new Error("Flow download completed with an empty file.");
        return { path: destination, suggestedFileName, sourceUrl };
    }
    // Con Chrome compartido, la carpeta de descargas es global del navegador: la fija el último
    // proceso que se conectó, así que el archivo puede estar en el directorio temporal de otra sesión.
    async recoverSharedDownload(error, destination) {
        const match = /copyfile '([^']+)'/.exec(error?.message ?? "");
        if (!match)
            throw error;
        const guid = path.basename(match[1]);
        const tmp = os.tmpdir();
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const dirs = (await readdir(tmp, { withFileTypes: true }).catch(() => []))
                .filter((entry) => entry.isDirectory() && entry.name.startsWith("playwright-artifacts-"));
            for (const dir of dirs) {
                const candidate = path.join(tmp, dir.name, guid);
                const info = await stat(candidate).catch(() => undefined);
                if (info && info.size > 0) {
                    await copyFile(candidate, destination);
                    return;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw error;
    }
    validateFlowProjectUrl(projectUrl) {
        const url = new URL(projectUrl);
        const okLabs = url.hostname === "labs.google" && url.pathname.startsWith("/fx/tools/flow/project/"); const okFlow = url.hostname === "flow.google.com" && url.pathname.includes("/project/"); if (url.protocol !== "https:" || (!okLabs && !okFlow)) {
            throw new Error("Only official Google Flow project URLs are allowed.");
        }
    }
    async detectAuthentication() {
        const page = await this.ensurePage();
        const hostname = new URL(page.url()).hostname;
        if (hostname === "accounts.google.com" || (hostname !== "labs.google" && hostname !== "flow.google.com"))
            return "login_required";
        const signInLinks = page.locator("a[href*='accounts.google.com']").filter({ hasText: /sign in|登录|登入/i });
        return await signInLinks.count() ? "login_required" : "signed_in";
    }
    async visibleControls(selector) {
        const page = await this.ensurePage();
        const controls = [];
        const frames = page.frames();
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
            const locator = frames[frameIndex].locator(selector);
            const count = Math.min(await locator.count(), 200);
            for (let index = 0; index < count; index += 1) {
                const item = locator.nth(index);
                if (!(await item.isVisible().catch(() => false)))
                    continue;
                const label = await this.controlLabel(item);
                if (label)
                    controls.push({ locator: item, label, frame: frameIndex });
            }
        }
        return controls;
    }
    async controlLabel(locator) {
        return locator.evaluate((element) => {
            const html = element;
            let label = html.getAttribute("aria-label") ?? html.getAttribute("placeholder") ?? html.getAttribute("data-placeholder") ?? html.getAttribute("aria-placeholder") ?? html.getAttribute("title") ?? html.innerText ?? html.textContent ?? "";
            label = label.replace(/\s+/g, " ").trim();
            // flow.google.com: the empty prompt editor is a contenteditable with no text or label.
            if (!label && (html.isContentEditable || html.getAttribute("role") === "textbox"))
                label = "Prompt editor (empty)";
            return label.slice(0, 300);
        }).catch(() => "");
    }
    async visibleExactText(label) {
        const page = await this.ensurePage();
        const collect = async (exact) => {
            const matches = [];
            const frames = page.frames();
            for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
                const locator = frames[frameIndex].getByText(label, { exact });
                const count = Math.min(await locator.count(), 20);
                for (let index = 0; index < count; index += 1) {
                    const item = locator.nth(index);
                    if (await item.isVisible().catch(() => false))
                        matches.push({ locator: item, label, frame: frameIndex });
                }
            }
            return matches;
        };
        const exactMatches = await collect(true);
        return exactMatches.length > 0 ? exactMatches : collect(false);
    }
    chooseControl(controls, label, index, kind) {
        if (typeof index === "number") {
            if (!controls[index])
                throw new Error(`${kind} index ${index} does not exist.`);
            return controls[index];
        }
        if (!label)
            throw new Error(`Provide an exact ${kind} label or index from flow_inspect_page.`);
        const normalized = label.trim().toLocaleLowerCase();
        const matches = controls.filter((control) => control.label.toLocaleLowerCase() === normalized);
        if (matches.length !== 1)
            throw new Error(`Expected exactly one ${kind} labelled "${label}", found ${matches.length}. Inspect the page and use an index.`);
        return matches[0];
    }
}
//# sourceMappingURL=flow-adapter.js.map