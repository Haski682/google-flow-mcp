import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
const initialState = () => ({
    version: 2,
    auth: { status: "browser_closed" },
    projects: [],
    jobs: [],
    assets: [],
});
function deriveDatabasePath(configuredPath) {
    return configuredPath.toLowerCase().endsWith(".json")
        ? configuredPath.slice(0, -5) + ".sqlite"
        : configuredPath;
}
export class StateStore {
    filePath;
    legacyJsonPath;
    database;
    queue = Promise.resolve();
    constructor(databasePath, legacyJsonPath) {
        this.filePath = deriveDatabasePath(databasePath);
        this.legacyJsonPath = legacyJsonPath ?? (databasePath.toLowerCase().endsWith(".json") ? databasePath : undefined);
        mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.database = new DatabaseSync(this.filePath);
        this.database.exec("PRAGMA journal_mode=WAL");
        this.database.exec("PRAGMA synchronous=FULL");
        this.database.exec("PRAGMA foreign_keys=ON");
        this.database.exec("PRAGMA busy_timeout=5000");
        this.initialize();
        this.migrateLegacyJson();
    }
    async read() {
        const authRow = this.database.prepare("SELECT payload FROM auth WHERE id = 1").get();
        const projects = this.database.prepare("SELECT payload FROM projects ORDER BY created_at").all();
        const jobs = this.database.prepare("SELECT payload FROM jobs ORDER BY created_at").all();
        const assets = this.database.prepare("SELECT payload FROM assets ORDER BY created_at").all();
        return {
            version: 2,
            auth: authRow ? JSON.parse(authRow.payload) : { status: "browser_closed" },
            projects: projects.map((row) => JSON.parse(row.payload)),
            jobs: jobs.map((row) => JSON.parse(row.payload)),
            assets: assets.map((row) => JSON.parse(row.payload)),
        };
    }
    async update(mutator) {
        let result;
        const operation = this.queue.catch(() => undefined).then(async () => {
            const state = await this.read();
            await mutator(state);
            this.write(state);
            result = state;
        });
        this.queue = operation.then(() => undefined, () => undefined);
        await operation;
        return result;
    }
    async createProject(input) {
        const now = new Date().toISOString();
        const project = {
            id: randomUUID(), ...input, stage: "draft", status: "active", createdAt: now, updatedAt: now,
        };
        await this.update((state) => {
            state.projects.push(project);
            // No se invalida el login compartido: otra sesión puede estar usando Flow en este momento.
        });
        this.recordEvent("project.created", project.id, project);
        return project;
    }
    async createJob(input) {
        const state = await this.read();
        const existing = state.jobs.find((job) => job.idempotencyKey === input.idempotencyKey && job.state !== "failed");
        if (existing)
            return { job: existing, reused: true };
        const attempt = 1 + Math.max(0, ...state.jobs.filter((job) => job.idempotencyKey === input.idempotencyKey).map((job) => job.attempt));
        const now = new Date().toISOString();
        const job = {
            id: randomUUID(), projectId: input.projectId, provider: "google_flow", operation: input.operation,
            idempotencyKey: input.idempotencyKey, prompt: input.prompt, state: "draft", attempt, createdAt: now, updatedAt: now,
        };
        await this.update((next) => { next.jobs.push(job); });
        this.recordEvent("job.created", job.id, job);
        return { job, reused: false };
    }
    async updateJob(id, patch) {
        let result;
        await this.update((state) => {
            const job = state.jobs.find((item) => item.id === id);
            if (!job)
                throw new Error(`Job not found: ${id}`);
            this.assertJobTransition(job.state, patch.state);
            Object.assign(job, patch, { id: job.id, updatedAt: new Date().toISOString() });
            if (patch.state === "complete") {
                job.error = undefined;
                job.completedAt ??= new Date().toISOString();
            }
            result = job;
        });
        this.recordEvent("job.updated", id, patch);
        return result;
    }
    async registerAsset(input) {
        const state = await this.read();
        const existing = state.assets.find((asset) => (input.providerMediaId && asset.providerMediaId === input.providerMediaId) ||
            (input.sourcePath && asset.projectId === input.projectId && asset.sourcePath === input.sourcePath));
        const now = new Date().toISOString();
        if (existing) {
            const updated = { ...existing, ...input, id: existing.id, updatedAt: now };
            await this.update((next) => {
                const index = next.assets.findIndex((asset) => asset.id === existing.id);
                next.assets[index] = updated;
            });
            return updated;
        }
        const asset = { id: input.id ?? randomUUID(), ...input, createdAt: now, updatedAt: now };
        await this.update((next) => { next.assets.push(asset); });
        this.recordEvent("asset.registered", asset.id, asset);
        return asset;
    }
    async linkFlowProject(id, flowProjectUrl) {
        let result;
        await this.update((state) => {
            const project = state.projects.find((item) => item.id === id);
            if (!project)
                throw new Error(`Project not found: ${id}`);
            project.flowProjectUrl = flowProjectUrl;
            project.updatedAt = new Date().toISOString();
            result = project;
        });
        return result;
    }
    health() {
        const integrity = this.database.prepare("PRAGMA integrity_check").get();
        const journal = this.database.prepare("PRAGMA journal_mode").get();
        const version = this.database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get();
        return { databasePath: this.filePath, integrity: integrity.integrity_check, journalMode: journal.journal_mode, schemaVersion: Number(version.value) };
    }
    async backup(destinationPath) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const destination = path.resolve(destinationPath ?? path.join(path.dirname(this.filePath), "backups", `state-${stamp}.sqlite`));
        if (existsSync(destination))
            throw new Error(`Backup destination already exists: ${destination}`);
        mkdirSync(path.dirname(destination), { recursive: true });
        const pages = await backup(this.database, destination);
        const target = new DatabaseSync(destination, { readOnly: true });
        try {
            const integrity = target.prepare("PRAGMA integrity_check").get();
            if (integrity.integrity_check !== "ok")
                throw new Error(`Backup integrity check failed: ${integrity.integrity_check}`);
        }
        finally {
            target.close();
        }
        const { size } = await import("node:fs/promises").then(({ stat }) => stat(destination));
        return { path: destination, pages, bytes: size };
    }
    close() { this.database.close(); }
    initialize() {
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs(project_id);
      CREATE INDEX IF NOT EXISTS jobs_idempotency_idx ON jobs(idempotency_key);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, provider_media_id TEXT,
        created_at TEXT NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS assets_provider_media_idx ON assets(provider_media_id) WHERE provider_media_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, kind TEXT NOT NULL,
        entity_id TEXT, payload TEXT NOT NULL
      );
    `);
        this.database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', '2')").run();
        const auth = this.database.prepare("SELECT id FROM auth WHERE id = 1").get();
        if (!auth)
            this.database.prepare("INSERT INTO auth(id, payload) VALUES (1, ?)").run(JSON.stringify(initialState().auth));
    }
    migrateLegacyJson() {
        if (!this.legacyJsonPath || !existsSync(this.legacyJsonPath))
            return;
        const count = this.database.prepare("SELECT COUNT(*) AS count FROM projects").get();
        if (Number(count.count) > 0)
            return;
        const legacy = JSON.parse(readFileSync(this.legacyJsonPath, "utf8"));
        const migrated = {
            version: 2, auth: legacy.auth, projects: legacy.projects, jobs: legacy.jobs, assets: legacy.assets ?? [],
        };
        this.write(migrated);
        this.database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('legacy_json_migrated_from', ?)").run(this.legacyJsonPath);
        this.recordEvent("state.migrated", undefined, { source: this.legacyJsonPath });
    }
    write(state) {
        this.database.exec("BEGIN IMMEDIATE");
        try {
            this.database.prepare("INSERT OR REPLACE INTO auth(id, payload) VALUES (1, ?)").run(JSON.stringify(state.auth));
            this.database.exec("DELETE FROM assets; DELETE FROM jobs; DELETE FROM projects;");
            const projectStatement = this.database.prepare("INSERT INTO projects(id, created_at, payload) VALUES (?, ?, ?)");
            const jobStatement = this.database.prepare("INSERT INTO jobs(id, project_id, idempotency_key, state, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)");
            const assetStatement = this.database.prepare("INSERT INTO assets(id, project_id, provider_media_id, created_at, payload) VALUES (?, ?, ?, ?, ?)");
            for (const project of state.projects)
                projectStatement.run(project.id, project.createdAt, JSON.stringify(project));
            for (const job of state.jobs)
                jobStatement.run(job.id, job.projectId, job.idempotencyKey, job.state, job.createdAt, JSON.stringify(job));
            for (const asset of state.assets)
                assetStatement.run(asset.id, asset.projectId, asset.providerMediaId ?? null, asset.createdAt, JSON.stringify(asset));
            this.database.exec("COMMIT");
        }
        catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }
    recordEvent(kind, entityId, payload) {
        this.database.prepare("INSERT INTO events(created_at, kind, entity_id, payload) VALUES (?, ?, ?, ?)")
            .run(new Date().toISOString(), kind, entityId ?? null, JSON.stringify(payload));
    }
    assertJobTransition(current, next) {
        if (!next || next === current)
            return;
        const allowed = {
            draft: ["prepared", "failed", "paused"], prepared: ["submitted", "failed", "paused"],
            submitted: ["generating", "complete", "failed", "paused"], generating: ["complete", "failed", "paused"],
            complete: ["complete"], failed: ["failed", "complete"], paused: ["prepared", "submitted", "generating", "failed", "paused"],
        };
        if (!allowed[current].includes(next))
            throw new Error(`Invalid job transition: ${current} -> ${next}`);
    }
}
//# sourceMappingURL=state.js.map