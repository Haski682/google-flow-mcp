#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createGoogleFlowServer } from "./server.js";
const config = loadConfig();
let activeFlow;
let activeStore;
const handle = serveStdio(() => {
    const instance = createGoogleFlowServer(config);
    activeFlow = instance.flow;
    activeStore = instance.store;
    return instance.server;
});
console.error("Google Flow Browser MCP 1.0.0 running on stdio");
async function shutdown() {
    await activeFlow?.close();
    activeStore?.close();
    await handle.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
//# sourceMappingURL=index.js.map