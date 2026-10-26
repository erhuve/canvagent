import express from 'express';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createApplication, type ApplicationOptions } from './app.js';
import { APP_NOTIFICATION_LIMIT } from '../shared/notifications.js';

type Application = ReturnType<typeof createApplication>;
type RegisteredProject = { id: string; workspace: string; dataDir: string };
const registrySchema = z.object({
  version: z.literal(1),
  projects: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{16}$/), workspace: z.string(), dataDir: z.string() })),
  activeProjectId: z.string().optional(),
  notificationSettings: z.object({ systemEnabled: z.boolean() }).optional(),
});

export interface WorkspaceHostOptions extends Omit<ApplicationOptions, 'dataDir' | 'basePath' | 'publicPort'> {
  /** Directory containing the project registry and each project's saved data. */
  dataRoot: string;
  /** An explicit saved-data directory for the initial workspace. */
  dataDir?: string;
  /** Reuse the previous CLI's saved-data directory when adding a known folder. */
  reuseLegacyData?: boolean;
}

export function workspaceId(workspace: string) {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 16);
}

/** One HTTP origin hosts independent, long-lived workspace applications. */
export function createWorkspaceHost(options: WorkspaceHostOptions) {
  const dataRoot = resolve(options.dataRoot);
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const registryPath = join(dataRoot, 'projects.json');
  const registry = existsSync(registryPath)
    ? registrySchema.parse(JSON.parse(readFileSync(registryPath, 'utf8')))
    : { version: 1 as const, projects: [] as RegisteredProject[], activeProjectId: undefined as string | undefined, notificationSettings: undefined };
  const registered = new Map(registry.projects.map(project => [project.id, project]));
  const applications = new Map<string, Application>();
  const unavailable = new Map<string, string>();
  const app = express();
  const server = createServer(app);
  const token = randomBytes(32).toString('hex');
  let closed = false;
  let activeProjectId = registry.activeProjectId ?? '';
  let notificationSettings = registry.notificationSettings ?? { systemEnabled: false };
  const projectPath = (id: string) => `/projects/${id}/`;
  const publicPort = () => {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : options.port;
  };
  function persist() {
    const temporary = `${registryPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, projects: [...registered.values()], activeProjectId, notificationSettings }, null, 2), { mode: 0o600 });
    renameSync(temporary, registryPath);
  }
  function canonicalWorkspace(path: string) {
    let workspace: string;
    try {
      workspace = realpathSync(resolve(path));
      if (!statSync(workspace).isDirectory()) throw new Error('not a directory');
    } catch { throw Object.assign(new Error('Choose an existing workspace folder.'), { status: 400 }); }
    return workspace;
  }
  function load(project: RegisteredProject) {
    const existing = applications.get(project.id);
    if (existing) {
      if (existing.store.dataDir !== resolve(project.dataDir)) throw new Error('This workspace is already open with another saved-data directory.');
      return existing;
    }
    if (canonicalWorkspace(project.workspace) !== project.workspace || workspaceId(project.workspace) !== project.id) {
      throw new Error('The workspace folder has changed. Add its current location again.');
    }
    const application = createApplication({ ...options, workspace: project.workspace, dataDir: project.dataDir,
      basePath: projectPath(project.id).slice(0, -1), publicPort });
    applications.set(project.id, application);
    unavailable.delete(project.id);
    return application;
  }
  function register(path: string, explicitDataDir?: string) {
    const workspace = canonicalWorkspace(path);
    const id = workspaceId(workspace);
    const previous = registered.get(id);
    const legacyDirectory = join(homedir(), '.local', 'share', 'canvagent', id);
    const dataDir = explicitDataDir ? resolve(explicitDataDir) : previous?.dataDir
      ?? (options.reuseLegacyData && existsSync(join(legacyDirectory, 'canvagent.sqlite')) ? legacyDirectory : join(dataRoot, id));
    const project = { id, workspace, dataDir };
    // Validate and open the Store before committing the registry entry.
    load(project);
    registered.set(id, project);
    return { project, added: !previous };
  }
  let initialProjectId: string;
  try {
    initialProjectId = register(options.workspace, options.dataDir).project.id;
    for (const project of registered.values()) {
      if (applications.has(project.id)) continue;
      try { load(project); } catch (error) { unavailable.set(project.id, error instanceof Error ? error.message : String(error)); }
    }
    if (!applications.has(activeProjectId)) activeProjectId = initialProjectId;
    persist();
  } catch (error) {
    for (const application of applications.values()) void application.close();
    throw error;
  }
  function projectSummary(project: RegisteredProject) {
    const application = applications.get(project.id);
    return application ? { id: project.id, ...application.summary(), available: true } : {
      id: project.id, name: project.workspace.split('/').filter(Boolean).at(-1) ?? 'Project', workspace: project.workspace,
      sessions: [], activeSessionId: '', available: false, error: unavailable.get(project.id) ?? 'Workspace unavailable.',
    };
  }
  const projects = () => [...registered.values()].map(projectSummary);
  const notifications = () => [...applications.values()].flatMap(application => application.notifications())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, APP_NOTIFICATION_LIMIT);
  const validLocalHost = (host: string | undefined) => {
    try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${host}`).hostname); } catch { return false; }
  };
  const originAllowed = (origin: string | undefined) => {
    if (!origin) return true;
    try {
      const url = new URL(origin);
      return url.protocol === 'http:' && validLocalHost(url.host) && [String(publicPort() ?? 4317), '5173'].includes(url.port);
    } catch { return false; }
  };
  const authenticated = (cookie: string | undefined) => {
    const candidate = cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('canvagent_host='))?.slice('canvagent_host='.length);
    return !!candidate && /^[a-f0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(token, 'hex'));
  };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    if (!validLocalHost(req.headers.host) || !originAllowed(req.headers.origin)) return res.status(403).json({ error: 'Local origin required.' });
    next();
  });
  app.get('/', (_req, res) => res.redirect(projectPath(initialProjectId)));
  app.get('/api/projects', (_req, res) => {
    res.cookie('canvagent_host', token, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.json({ projects: projects(), activeProjectId });
  });
  app.get('/api/notifications', (_req, res) => {
    res.cookie('canvagent_host', token, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.json({ notifications: notifications() });
  });
  app.post('/api/notifications/read', express.json({ limit: '32kb' }), (req, res) => {
    if (!authenticated(req.headers.cookie)) return res.status(401).json({ error: 'Open the app to initialize the local session.' });
    const { ids } = z.object({ ids: z.array(z.string().min(1).max(200)).max(APP_NOTIFICATION_LIMIT) }).strict().parse(req.body);
    for (const application of applications.values()) application.markNotificationsRead(ids);
    res.json({ notifications: notifications() });
  });
  app.get('/api/notification-settings', (_req, res) => {
    res.cookie('canvagent_host', token, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.json(notificationSettings);
  });
  app.post('/api/notification-settings', express.json({ limit: '1kb' }), (req, res) => {
    if (!authenticated(req.headers.cookie)) return res.status(401).json({ error: 'Open the app to initialize the local session.' });
    notificationSettings = z.object({ systemEnabled: z.boolean() }).strict().parse(req.body);
    persist(); res.json(notificationSettings);
  });
  app.post('/api/projects', express.json({ limit: '16kb' }), (req, res) => {
    if (!authenticated(req.headers.cookie)) return res.status(401).json({ error: 'Open the app to initialize the local session.' });
    const input = z.object({ workspace: z.string().trim().min(1).max(4096) }).parse(req.body);
    const { project, added } = register(input.workspace);
    activeProjectId = project.id; persist();
    res.status(added ? 201 : 200).json({ project: projectSummary(project), path: projectPath(project.id) });
  });
  app.use('/projects/:projectId', (req, res, next) => {
    const id = req.params.projectId;
    const application = applications.get(id);
    if (!application) return res.status(registered.has(id) ? 410 : 404).json({ error: registered.has(id) ? 'Workspace folder unavailable. Add its current location to continue.' : 'Project not found.' });
    if (req.path === '/api/state' && req.method === 'GET' && activeProjectId !== id) { activeProjectId = id; persist(); }
    application.app(req, res, next);
  });
  // The production bundle and Excalidraw reference these shared static assets
  // from the origin root; workspace data and APIs remain under their prefix.
  const dist = options.distDir ?? resolve('dist');
  app.use('/assets', express.static(join(dist, 'assets')));
  app.use('/brand', express.static(join(dist, 'brand')));
  app.use('/excalidraw-assets', express.static(options.assetsDir ?? resolve(import.meta.dirname, '../../node_modules/@excalidraw/excalidraw/dist/prod'), { maxAge: '1y', immutable: true }));
  app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof z.ZodError ? 400 : error.status ?? 500;
    res.status(status).json({ error: error instanceof z.ZodError ? 'Invalid request.' : error.message ?? 'Request failed.' });
  });
  server.on('upgrade', (req, socket, head) => {
    const match = /^\/projects\/([a-f0-9]{16})(\/api\/(?:events|terminals\/[0-9a-f-]{36}\/events))$/.exec(req.url ?? '');
    const application = match && applications.get(match[1]);
    if (!application) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    req.url = match[2];
    application.handleUpgrade(req, socket, head);
  });
  return {
    app, server, applications, initialProjectId, projectPath, projects, notifications,
    async close() {
      if (closed) return; closed = true;
      await Promise.all([...applications.values()].map(application => application.close()));
      await new Promise<void>(resolveClose => { if (!server.listening) return resolveClose(); server.close(() => resolveClose()); server.closeAllConnections(); });
    },
  };
}
