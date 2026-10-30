export interface Config {
    browserExecutable: string;
    profileDir: string;
    stateFile: string;
    databaseFile?: string;
    downloadDir?: string;
}
export declare function loadConfig(cwd?: string): Config;
