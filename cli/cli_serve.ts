import { loadConfig, resolveBindings, resolveProfileOpt } from './config_loader.ts';
import { consoleError, consoleLog } from '../common/console.ts';
import { DenoflareResponse } from '../common/denoflare_response.ts';
import { LocalDurableObjects } from '../common/local_durable_objects.ts';
import { NoopCfGlobalCaches } from '../common/noop_cf_global_caches.ts';
import { WorkerManager } from './worker_manager.ts';
import { ApiKVNamespace } from './api_kv_namespace.ts';
import { WorkerExecution, WorkerExecutionCallbacks } from '../common/worker_execution.ts';
import { makeIncomingRequestCfProperties } from '../common/incoming_request_cf_properties.ts';
import { UnimplementedDurableObjectNamespace } from '../common/unimplemented_cloudflare_stubs.ts';
import { ModuleWatcher } from './module_watcher.ts';
import { CLI_VERSION } from './cli_version.ts';
import { Binding, Isolation, Script } from '../common/config.ts';
import { computeContentsForScriptReference } from './cli_common.ts';
import { isValidScriptName } from '../common/config_validation.ts';
import { RpcChannel } from '../common/rpc_channel.ts';
import { ModuleWorkerExecution } from '../common/module_worker_execution.ts';
import { redefineGlobalFetchToWorkaroundBareIpAddresses } from '../common/deno_workarounds.ts';
import { FetchUtil } from '../common/fetch_util.ts';
import { LocalWebSockets } from '../common/local_web_sockets.ts';
import { CloudflareWebSocketExtensions } from '../common/cloudflare_workers_types.d.ts';

export async function serve(args: (string | number)[], options: Record<string, unknown>) {
    const scriptSpec = args[0];
    if (options.help || typeof scriptSpec !== 'string') {
        dumpHelp();
        return;
    }

    const verbose = !!options.verbose;
    if (verbose) {
        // in cli
        ModuleWatcher.VERBOSE = verbose;
        WorkerManager.VERBOSE = verbose;
        DenoWebSocketForwarder.VERBOSE = verbose;

        // in common
        RpcChannel.VERBOSE = verbose;
        ModuleWorkerExecution.VERBOSE = verbose;
        FetchUtil.VERBOSE = verbose;
        LocalWebSockets.VERBOSE = verbose;
    }

    const start = Date.now();
    const config = await loadConfig(options);
    const nameFromOptions = typeof options.name === 'string' && options.name.trim().length > 0 ? options.name.trim() : undefined;
    const { scriptName, rootSpecifier } = await computeContentsForScriptReference(scriptSpec, config, nameFromOptions);
 
    const scriptUrl = rootSpecifier.startsWith('https://') ? new URL(rootSpecifier) : undefined;
    if (scriptUrl && !scriptUrl.pathname.endsWith('.ts')) throw new Error('Url-based module workers must end in .ts');
    
    // read the script-based cloudflare worker contents
    let port = DEFAULT_PORT;
    let bindingsProvider: () => Promise<Record<string, Binding>> = () => Promise.resolve({});
    let isolation: Isolation = 'isolate';
    let script: Script | undefined;
    let localHostname: string | undefined;
    if (isValidScriptName(scriptSpec)) {
        script = config.scripts && config.scripts[scriptName];
        if (script === undefined) throw new Error(`Script '${scriptName}' not found`);
        if (script.localPort) port = script.localPort;
        let pushNumber = 1;
        bindingsProvider = async () => {
            const pushId = isolation === 'none' ? undefined : `${pushNumber++}`;
            return await resolveBindings(script!.bindings || {}, port, pushId);
        }
        isolation = script.localIsolation || isolation;
        localHostname = script.localHostname;
    } else {
        if (typeof options.port === 'number') {
            port = options.port;
        }
    }
    const profile = await resolveProfileOpt(config, options);

    redefineGlobalFetchToWorkaroundBareIpAddresses();

    const computeScriptContents = async (scriptPathOrModuleWorkerUrl: string, scriptType: 'module' | 'script'): Promise<Uint8Array> => {
        console.log({ scriptType })
        
        if (scriptType === 'script') {
            if (scriptPathOrModuleWorkerUrl.startsWith('https://')) throw new Error('Url-based script workers not supported yet');
            return await Deno.readFile(scriptPathOrModuleWorkerUrl);
        }
        const start = Date.now();
        const result = await Deno.emit(scriptPathOrModuleWorkerUrl, {
            bundle: 'module',
        });
        if (verbose) consoleLog('computeScriptContents: result', result);
        const workerJs = result.files['deno:///bundle.js'];
        const rt = new TextEncoder().encode(workerJs);
        console.log(`Compiled ${scriptPathOrModuleWorkerUrl} into module contents in ${Date.now() - start}ms`);
        return rt;
    }

    const createLocalRequestServer = async (): Promise<LocalRequestServer> => {
        const scriptType = /^.*\.(ts|mjs)$/.test(rootSpecifier) ? 'module' : 'script';
        if (isolation === 'none') {
            let objects: LocalDurableObjects | undefined; 
            const localWebSockets = new LocalWebSockets();
            const callbacks: WorkerExecutionCallbacks = {
                onModuleWorkerInfo: moduleWorkerInfo => { 
                    const { moduleWorkerExportedFunctions, moduleWorkerEnv } = moduleWorkerInfo;
                    objects = new LocalDurableObjects({ moduleWorkerExportedFunctions, moduleWorkerEnv });
                },
                globalCachesProvider: () => new NoopCfGlobalCaches(),
                webSocketPairProvider: () => localWebSockets.allocateNewWebSocketPair(),
                kvNamespaceProvider: kvNamespace => ApiKVNamespace.ofProfile(profile, kvNamespace),
                doNamespaceProvider: doNamespace => {
                    // console.log(`doNamespaceProvider`, doNamespace, objects);
                    if (objects === undefined) return new UnimplementedDurableObjectNamespace(doNamespace);
                    return objects.resolveDoNamespace(doNamespace);
                },
                incomingRequestCfPropertiesProvider: () => makeIncomingRequestCfProperties(),
            };
            const bindings = await bindingsProvider();
            return await WorkerExecution.start(rootSpecifier, scriptType, bindings, callbacks);
        } else {
            // start the host for the permissionless deno workers
            const workerManager = await WorkerManager.start();
        
            // run the cloudflare worker script inside deno worker
            const runScript = async () => {
                consoleLog(`runScript: ${rootSpecifier}`);

                const bindings = await bindingsProvider();

                const scriptContents = await computeScriptContents(rootSpecifier, scriptType);
                try {
                    await workerManager.run(scriptContents, scriptType, { bindings, profile });
                } catch (e) {
                    consoleError('Error running script', e.stack || e);
                    Deno.exit(1);
                }
            };
            await runScript();
        
            // when a file-based script changes, recreate the deno worker
            if (!rootSpecifier.startsWith('https://')) {
                const _moduleWatcher = new ModuleWatcher(rootSpecifier, runScript);
            }
            return workerManager;
        }
    }

    const localRequestServer = await createLocalRequestServer();

    // start local server
    function memoize<T>(fn: () => Promise<T>): () => Promise<T> {
        let cached: T | undefined;
        return async () => {
            if (cached !== undefined) return cached;
            const rt = await fn();
            cached = rt;
            return rt;
        }
    }

    async function fetchExternalIp(): Promise<string> {
        consoleLog('fetchExternalIp: Fetching...');
        const start = Date.now();
        const trace = await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
        const m = /ip=([^\s]*)/.exec(trace);
        if (!m) throw new Error(`computeExternalIp: Unexpected trace: ${trace}`);
        const externalIp = m[1];
        consoleLog(`fetchExternalIp: Determined to be ${externalIp} in ${Date.now() - start}ms`)
        return externalIp;
    }

    const computeExternalIp = memoize(fetchExternalIp);

    async function handle(conn: Deno.Conn) {
        const httpConn = Deno.serveHttp(conn);
        for await (const { request, respondWith } of httpConn) {
            try {
                const cfConnectingIp = await computeExternalIp();
                const hostname = localHostname;
                const upgrade = request.headers.get('upgrade') || undefined;
                if (upgrade !== undefined) {
                    // websocket upgrade request
                    if (upgrade !== 'websocket') throw new Error(`Unsupported upgrade: ${upgrade}`);
                    const { socket, response } = Deno.upgradeWebSocket(request);
                    const denoWebSocketForwarder = new DenoWebSocketForwarder(socket);
                    const res = await localRequestServer.fetch(request, { cfConnectingIp, hostname });
                    if (DenoflareResponse.is(res) && res.init && res.init.webSocket) {
                        if (res.init?.status !== 101) throw new Error(`Bad response status: expected 101, found ${res.init?.status}`);
                        denoWebSocketForwarder.setClientSocket(res.init.webSocket);
                    } else {
                        if (!DenoflareResponse.is(res)) {
                            const txt = await res.text();
                            console.warn('WARNING: Did not receive a DenoflareResponse back from a WS upgrade request!', res, txt);
                        } else if (!res.init || !res.init.webSocket) {
                            const txt = await res.text();
                            console.warn('WARNING: Did not receive a WebSocket back from a WS upgrade request!', res, txt);
                        }
                    }
                    await respondWith(response).catch(e => consoleError(`Error in respondWith`, e.stack || e));
                } else {
                    // normal request
                    let res = await localRequestServer.fetch(request, { cfConnectingIp, hostname });
                    if (DenoflareResponse.is(res)) {
                        res = res.toRealResponse();
                    }
                    await respondWith(res).catch(e => consoleError(`Error in respondWith`, e.stack || e));
                }
            } catch (e) {
                consoleError('Error servicing request', e.stack || e);
            }
        }
    }
    consoleLog(`Started in ${Date.now() - start}ms (isolation=${isolation})`);

    const server = Deno.listen({ port });
    consoleLog(`Local server running on http://localhost:${port}`);

    for await (const conn of server) {
        handle(conn).catch(e => consoleError('Error in handle', e.stack || e));
    }
}

//

interface LocalRequestServer {
    fetch(request: Request, opts: { cfConnectingIp: string, hostname?: string }): Promise<Response | DenoflareResponse>;
}

class DenoWebSocketForwarder {
    static VERBOSE = false;

    private readonly socket: WebSocket;

    private clientSocket: WebSocket & CloudflareWebSocketExtensions | undefined;

    constructor(socket: WebSocket) {
        socket.onopen = _event => {
            if (DenoWebSocketForwarder.VERBOSE) consoleLog('DenoWebSocketForwarder: socket onopen');
        };
        socket.onmessage = event => {
            if (DenoWebSocketForwarder.VERBOSE) consoleLog('DenoWebSocketForwarder: socket onmessage:', event.data);
            this.ensureClientSocket().send(event.data);
        };
        socket.onerror = event => {
            consoleLog('DenoWebSocketForwarder: socket onerror:', event);
            // only useful on this side, and will be followed by close
        };
        socket.onclose = event => {
            const { code, reason } = event;
            if (DenoWebSocketForwarder.VERBOSE) consoleLog('DenoWebSocketForwarder: socket onclose');
            this.ensureClientSocket().close(code, reason);
        };
        this.socket = socket;
    }

    setClientSocket(clientSocket: WebSocket & CloudflareWebSocketExtensions) {
        if (this.clientSocket) throw new Error('DenoWebSocketForwarder: already set clientSocket');
        clientSocket.accept();
        clientSocket.onmessage = event => {
            this.socket.send(event.data);
        };
        clientSocket.onclose = event => {
            const { code, reason } = event;
            this.socket.close(code, reason);
        }
        this.clientSocket = clientSocket;
        console.log('DenoWebSocketForwarder: setClientSocket');
    }

    //

    private ensureClientSocket(): WebSocket {
        if (!this.clientSocket) throw new Error(`DenoWebSocketForwarder: no clientSocket`);
        return this.clientSocket;
    }

}

//

const DEFAULT_PORT = 8080;

function dumpHelp() {
    const lines = [
        `denoflare-serve ${CLI_VERSION}`,
        'Run a worker script on a local web server',
        '',
        'USAGE:',
        '    denoflare serve [FLAGS] [OPTIONS] [--] [script-spec]',
        '',
        'FLAGS:',
        '    -h, --help        Prints help information',
        '        --verbose     Toggle verbose output (when applicable)',
        '',
        'OPTIONS:',
        `        --port <number>     Local port to use for the http server (default: ${DEFAULT_PORT})`,
        '        --profile <name>    Name of profile to load from config (default: only profile or default profile in config)',
        '        --config <path>     Path to config file (default: .denoflare in cwd or parents)',
        '',
        'ARGS:',
        '    <script-spec>    Name of script defined in .denoflare config, file path to bundled js worker, or an https url to a module-based worker .ts, e.g. https://path/to/worker.ts',
    ];
    for (const line of lines) {
        console.log(line);
    }
}
