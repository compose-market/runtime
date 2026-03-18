
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * NPX Client Transport for MCP
 * 
 * Wraps StdioClientTransport to execute servers via `npx -y <package>`.
 * Useful for ephemeral, zero-install server execution.
 */
export class NpxClientTransport extends StdioClientTransport {
    constructor(config: {
        package: string;
        args?: string[];
        env?: Record<string, string>;
    }) {
        const command = "npx";
        const args = ["-y", config.package, ...(config.args || [])];

        super({
            command,
            args,
            env: {
                ...Object.fromEntries(
                    Object.entries(process.env).filter(([_, v]) => v !== undefined)
                ) as Record<string, string>,
                ...config.env
            }
        });
    }
}
