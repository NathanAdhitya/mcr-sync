import { watch } from "fs";
import { load } from "js-yaml";
import { readFile } from "fs/promises";
import Docker from "dockerode";

// --- CONFIGURATION ---
const CONFIG_PATH = "./config.yml";
const MC_ROUTER_API_URL = process.env.MC_ROUTER_API_URL || "http://localhost:5001"; // Use environment variable or default
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
const DOCKER_HOST_IP = process.env.DOCKER_HOST_IP || '127.0.0.1'; // IP for mc-router to connect to containers
const POLLING_INTERVAL_MS = 5000; // 5 seconds

// --- TYPE DEFINITIONS ---
interface ManualServerConfig {
    host: string;
    port: number;
    override_suffix?: string[];
}

interface Config {
    default_domain_suffix: string[];
    manual: Record<string, ManualServerConfig>;
}

type McRouterRoutes = Record<string, string>;


// --- INITIALIZATION ---
const docker = new Docker({ socketPath: DOCKER_SOCKET_PATH });
let lastKnownConfig: Config | null = null;

// --- LOGGING UTILITY ---
const log = (level: 'INFO' | 'WARN' | 'ERROR', message: string, ...args: any[]) => {
    console.log(`[${new Date().toISOString()}] [${level}] ${message}`, ...args);
};

// --- MC-ROUTER API CLIENT ---

/**
 * Fetches the current routes from the mc-router instance.
 * @returns The current routes or null if an error occurs.
 */
async function getMcRouterRoutes(): Promise<McRouterRoutes | null> {
    try {
        const response = await fetch(`${MC_ROUTER_API_URL}/routes`, {
            headers: { "Accept": "application/json" }
        });
        if (!response.ok) {
            log('ERROR', `Failed to get mc-router routes. Status: ${response.status}`);
            return null;
        }
        return await response.json() as McRouterRoutes;
    } catch (error) {
        log('ERROR', 'Error connecting to mc-router API:', error);
        return null;
    }
}

/**
 * Registers or updates a route in mc-router.
 * @param serverAddress The domain name to map.
 * @param backend The target host:port.
 */
async function addOrUpdateRoute(serverAddress: string, backend: string): Promise<void> {
    try {
        log('INFO', `Adding/Updating route: ${serverAddress} -> ${backend}`);
        const response = await fetch(`${MC_ROUTER_API_URL}/routes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverAddress, backend }),
        });
        if (!response.ok) {
            log('ERROR', `Failed to add route for ${serverAddress}. Status: ${response.status}`);
        }
    } catch (error) {
        log('ERROR', `Error adding route for ${serverAddress}:`, error);
    }
}

/**
 * Deletes a route from mc-router.
 * @param serverAddress The domain name to unmap.
 */
async function deleteRoute(serverAddress: string): Promise<void> {
    try {
        log('INFO', `Deleting route: ${serverAddress}`);
        const response = await fetch(`${MC_ROUTER_API_URL}/routes/${encodeURIComponent(serverAddress)}`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            log('ERROR', `Failed to delete route for ${serverAddress}. Status: ${response.status}`);
        }
    } catch (error) {
        log('ERROR', `Error deleting route for ${serverAddress}:`, error);
    }
}


// --- CORE LOGIC ---

/**
 * Loads and parses the YAML configuration file.
 * @returns The parsed configuration object.
 */
async function loadConfig(): Promise<Config | null> {
    try {
        const fileContent = await readFile(CONFIG_PATH, "utf-8");
        return load(fileContent) as Config;
    } catch (error) {
        log('ERROR', `Failed to read or parse ${CONFIG_PATH}:`, error);
        return null;
    }
}

/**
 * Scans Docker for running containers with the 'router.slug' label.
 * @returns A map of slugs to their backend "ip:port".
 */
async function getDockerRoutes(): Promise<Map<string, string>> {
    const routes = new Map<string, string>();
    try {
        const containers = await docker.listContainers();
        for (const containerInfo of containers) {
            const slugsLabel = containerInfo.Labels['router.slug'];
            if (slugsLabel) {
                const slugs = slugsLabel.split(',').map(s => s.trim()).filter(Boolean); // split, trim, and remove empty
                const portData = containerInfo.Ports?.[0];

                if (portData?.PublicPort) {
                    const backend = `${DOCKER_HOST_IP}:${portData.PublicPort}`;
                    for (const slug of slugs) {
                        routes.set(slug, backend);
                    }
                } else {
                     log('WARN', `Container with slug(s) '${slugs.join(', ')}' found but has no mapped ports.`);
                }
            }
        }
    } catch (error) {
        log('ERROR', 'Failed to scan Docker containers:', error);
    }
    return routes;
}


/**
 * The main synchronization function. It computes the desired state and applies it to mc-router.
 */
async function syncRoutes() {
    log('INFO', 'Starting synchronization cycle...');

    const config = await loadConfig();
    if (!config) {
        log('WARN', 'Synchronization skipped: Configuration is invalid or unreadable.');
        return;
    }
    lastKnownConfig = config; // Cache the latest valid config

    const dockerRoutes = await getDockerRoutes();
    const desiredRoutes = new Map<string, string>();

    // 1. Process Docker containers
    for (const [slug, backend] of dockerRoutes.entries()) {
        for (const suffix of config.default_domain_suffix) {
            desiredRoutes.set(`${slug}.${suffix}`, backend);
        }
    }

    // 2. Process manual entries
    for (const [slug, manualConfig] of Object.entries(config.manual)) {
        const backend = `${manualConfig.host}:${manualConfig.port}`;
        const suffixes = manualConfig.override_suffix || config.default_domain_suffix;
        for (const suffix of suffixes) {
            // Manual overrides can have a slug-only entry if override_suffix contains a full domain
            const fullAddress = suffix.includes('.') ? slug : `${slug}.${suffix}`;
             desiredRoutes.set(fullAddress, backend);
        }
    }
    
    // 3. Compare with current mc-router state and apply changes
    const currentRoutes = await getMcRouterRoutes();
    if (!currentRoutes) {
        log('WARN', 'Synchronization skipped: Could not retrieve current routes from mc-router.');
        return;
    }

    const currentMappings = new Map(Object.entries(currentRoutes));
    let changesMade = false;

    // Routes to add or update
    for (const [address, backend] of desiredRoutes.entries()) {
        if (currentMappings.get(address) !== backend) {
            await addOrUpdateRoute(address, backend);
            changesMade = true;
        }
    }

    // Routes to delete
    for (const [address] of currentMappings.entries()) {
        if (!desiredRoutes.has(address)) {
            await deleteRoute(address);
            changesMade = true;
        }
    }

    if (!changesMade) {
        log('INFO', 'Synchronization complete. No changes detected.');
    } else {
        log('INFO', 'Synchronization complete. Changes were applied.');
    }
}

// --- APPLICATION ENTRY POINT ---
async function main() {
    log('INFO', 'Starting mc-router synchronization service...');

    // Initial sync
    await syncRoutes();

    // Watch for config file changes
    watch(CONFIG_PATH, async (event, filename) => {
        if (event === 'change') {
            log('INFO', `${CONFIG_PATH} changed. Triggering synchronization.`);
            await syncRoutes();
        }
    });
    
    // Periodically poll Docker for container changes
    setInterval(async () => {
        log('INFO', 'Polling Docker for container changes...');
        await syncRoutes();
    }, POLLING_INTERVAL_MS);

    log('INFO', `Service started. Watching ${CONFIG_PATH} and polling Docker every ${POLLING_INTERVAL_MS / 1000}s.`);
}

main().catch(err => log('ERROR', 'An unhandled error occurred in the main execution:', err));


