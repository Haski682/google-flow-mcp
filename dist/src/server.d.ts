import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { FlowBrowserAdapter } from "./flow-adapter.js";
import { StateStore } from "./state.js";
export declare function createGoogleFlowServer(config: Config): {
    server: McpServer;
    flow: FlowBrowserAdapter;
    store: StateStore;
};
