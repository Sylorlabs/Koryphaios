/**
 * Port utilities for dynamic port allocation
 * Ensures the backend can always find an available port
 */

import { serverLog } from "../logger";

/**
 * Check if a port is available by attempting to bind to it
 */
export async function isPortAvailable(port: number, host: string = "127.0.0.1"): Promise<boolean> {
    try {
        const testServer = Bun.serve({
            port,
            hostname: host,
            fetch() {
                return new Response("test");
            },
        });
        testServer.stop();
        return true;
    } catch {
        return false;
    }
}

/**
 * Find an available port in a range
 * @param preferredPort - Try this port first
 * @param minPort - Minimum port number
 * @param maxPort - Maximum port number
 * @param host - Host to bind to
 * @returns The available port number
 */
export async function findAvailablePort(
    preferredPort: number,
    minPort: number = 29450,
    maxPort: number = 29500,
    host: string = "127.0.0.1"
): Promise<number> {
    // First, try the preferred port
    if (preferredPort >= 1024 && preferredPort <= 65535) {
        if (await isPortAvailable(preferredPort, host)) {
            return preferredPort;
        }
        serverLog.warn({ port: preferredPort }, "Preferred port in use, searching for alternative");
    }

    // Search in the designated range
    for (let port = minPort; port <= maxPort; port++) {
        if (await isPortAvailable(port, host)) {
            return port;
        }
    }

    // Fallback to ephemeral range
    serverLog.warn({ minPort, maxPort }, "Designated range full, searching ephemeral ports");
    for (let port = 49200; port <= 65535; port++) {
        if (await isPortAvailable(port, host)) {
            return port;
        }
    }

    throw new Error("No available ports found in any range");
}

/**
 * Write the active port to a file for the desktop app to discover
 */
export function writePortFile(projectRoot: string, port: number, host: string): void {
    try {
        const fs = require("node:fs");
        const path = require("node:path");
        
        const portInfo = {
            port,
            host,
            url: `http://${host}:${port}`,
            wsUrl: `ws://${host}:${port}/ws`,
            timestamp: Date.now(),
            pid: process.pid,
        };
        
        const portFile = path.join(projectRoot, ".koryphaios", ".active-port.json");
        fs.mkdirSync(path.dirname(portFile), { recursive: true });
        fs.writeFileSync(portFile, JSON.stringify(portInfo, null, 2));
        
        // Also set environment variable for child processes
        process.env.KORYPHAIOS_ACTUAL_PORT = String(port);
    } catch (err) {
        serverLog.warn({ err }, "Failed to write port file");
    }
}

/**
 * Read the active port from file (for desktop app)
 */
export function readPortFile(projectRoot: string): { port: number; host: string; url: string; wsUrl: string } | null {
    try {
        const fs = require("node:fs");
        const path = require("node:path");
        
        const portFile = path.join(projectRoot, ".koryphaios", ".active-port.json");
        if (!fs.existsSync(portFile)) {
            return null;
        }
        
        const content = fs.readFileSync(portFile, "utf-8");
        const info = JSON.parse(content);
        
        // Check if the port is still active (within last 5 minutes and PID exists)
        const maxAge = 5 * 60 * 1000; // 5 minutes
        if (Date.now() - info.timestamp > maxAge) {
            return null;
        }
        
        // On Unix, check if PID is still running
        try {
            process.kill(info.pid, 0);
        } catch {
            // PID not running
            return null;
        }
        
        return info;
    } catch {
        return null;
    }
}

/**
 * Clean up port file on shutdown
 */
export function cleanupPortFile(projectRoot: string): void {
    try {
        const fs = require("node:fs");
        const path = require("node:path");
        
        const portFile = path.join(projectRoot, ".koryphaios", ".active-port.json");
        if (fs.existsSync(portFile)) {
            fs.unlinkSync(portFile);
        }
    } catch {
        // Ignore cleanup errors
    }
}
