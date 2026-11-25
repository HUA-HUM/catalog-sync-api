import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';

export interface DocsSiteCredentials {
  username: string;
  password: string;
}

export interface DocsSiteOptions {
  /** Where the site is mounted, e.g. `/docs`. */
  basePath: string;
  /** Repository root: where README.md and docs/ live. */
  rootDirectory: string;
  /**
   * When present the whole site asks for HTTP Basic credentials and every page
   * is published. Without them the site is open and the restricted pages are
   * replaced by a notice.
   */
  credentials?: DocsSiteCredentials;
}

interface DocsPage {
  group: string;
  title: string;
  /** Path of the markdown file, relative to the repository root. */
  file: string;
  /**
   * Describes how the server is set up, where it runs and how credentials are
   * rotated, so it is only published when the site is behind a password.
   */
  restricted?: boolean;
}

/**
 * The published pages, in sidebar order. It doubles as the whitelist of files
 * the site may read, so nothing else in the repository can be requested.
 */
export const DOCS_PAGES: readonly DocsPage[] = [
  { group: 'Inicio', title: 'Catalog Sync API', file: 'README.md' },
  { group: 'Catálogo', title: 'Guía funcional', file: 'docs/funcional.md' },
  { group: 'Catálogo', title: 'Visitas', file: 'docs/visitas.md' },
  { group: 'API', title: 'Referencia de la API', file: 'docs/api.md' },
  {
    group: 'Técnico',
    title: 'Arquitectura y configuración',
    file: 'docs/tecnico.md',
  },
  {
    group: 'Técnico',
    title: 'Operación',
    file: 'docs/operacion.md',
    restricted: true,
  },
];

const HOME_FILE = 'README.md';
const CONTENT_PREFIX = '/content';

/**
 * Serves the repository's markdown documentation as a browsable site with a
 * sidebar and search. The markdown is read on every request, so a `git pull`
 * is enough to publish a text change.
 */
export function createDocsSiteRouter(options: DocsSiteOptions): Router {
  const router = Router();
  const basePath = normalizeBasePath(options.basePath);
  const isProtected = options.credentials !== undefined;

  if (options.credentials !== undefined) {
    router.use(requireBasicAuth(options.credentials));
  }

  router.get('/', (_request: Request, response: Response) => {
    response
      .type('html')
      .set('Cache-Control', 'no-cache')
      .send(buildShellHtml(basePath));
  });

  const sendSidebar = (_request: Request, response: Response) => {
    sendMarkdown(response, buildSidebarMarkdown(isProtected));
  };
  // Docsify asks for the sidebar next to the page it is showing before it
  // falls back to the root one; answering both spares a 404 on every page.
  router.get(`${CONTENT_PREFIX}/_sidebar.md`, sendSidebar);
  router.get(`${CONTENT_PREFIX}/docs/_sidebar.md`, sendSidebar);

  const sendPage = (file: string) => {
    return async (_request: Request, response: Response) => {
      const page = DOCS_PAGES.find((candidate) => candidate.file === file);
      if (page === undefined) {
        response.status(404).type('text/plain').send('Not found');
        return;
      }

      if (page.restricted === true && !isProtected) {
        sendMarkdown(response, buildRestrictedPageNotice(page));
        return;
      }

      try {
        sendMarkdown(
          response,
          await readFile(join(options.rootDirectory, page.file), 'utf-8'),
        );
      } catch {
        response.status(404).type('text/plain').send('Not found');
      }
    };
  };

  router.get(`${CONTENT_PREFIX}/${HOME_FILE}`, sendPage(HOME_FILE));
  router.get(
    `${CONTENT_PREFIX}/docs/:name`,
    (request: Request, response: Response) => {
      const name = String(request.params.name ?? '');
      return sendPage(`docs/${name}`)(request, response);
    },
  );

  return router;
}

export function buildSidebarMarkdown(includeRestricted: boolean): string {
  const lines: string[] = [];
  let currentGroup: string | null = null;

  for (const page of DOCS_PAGES) {
    if (page.restricted === true && !includeRestricted) {
      continue;
    }

    if (page.group !== currentGroup) {
      currentGroup = page.group;
      lines.push(`- **${page.group}**`);
    }

    lines.push(`  - [${page.title}](${toRoute(page.file)})`);
  }

  return `${lines.join('\n')}\n`;
}

function buildRestrictedPageNotice(page: DocsPage): string {
  return [
    `# ${page.title}`,
    '',
    'Esta página no está publicada en el sitio abierto: describe dónde corre el servicio y cómo se rotan las credenciales.',
    '',
    `Está disponible en el repositorio, en \`${page.file}\`.`,
    '',
  ].join('\n');
}

/** `README.md` is the home page; every other file keeps its repository path. */
function toRoute(file: string): string {
  return file === HOME_FILE ? '/' : `/${file}`;
}

function sendMarkdown(response: Response, markdown: string): void {
  response
    .type('text/markdown; charset=utf-8')
    .set('Cache-Control', 'no-cache')
    .send(markdown);
}

function requireBasicAuth(credentials: DocsSiteCredentials) {
  return (request: Request, response: Response, next: NextFunction) => {
    const received = parseBasicAuthorization(request.headers.authorization);
    if (
      received !== null &&
      safeEqual(received.username, credentials.username) &&
      safeEqual(received.password, credentials.password)
    ) {
      next();
      return;
    }

    response
      .status(401)
      .set(
        'WWW-Authenticate',
        'Basic realm="Catalog Sync API docs", charset="UTF-8"',
      )
      .type('text/plain')
      .send('Authentication required');
  };
}

function parseBasicAuthorization(
  header: string | undefined,
): DocsSiteCredentials | null {
  if (header === undefined || !header.startsWith('Basic ')) {
    return null;
  }

  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString(
    'utf-8',
  );
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

function safeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * The page itself is a Docsify shell: it fetches the markdown from
 * `<basePath>/content/` and renders it in the browser. Routes mirror the
 * repository layout (README at `/`, the rest under `/docs/`), which is what
 * keeps the relative links between the markdown files working both here and
 * on GitHub.
 */
function buildShellHtml(basePath: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Catalog Sync API · Documentación</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/themes/vue.css" />
  <style>
    :root {
      --theme-color: #0f766e;
      --content-max-width: 54rem;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    .app-name-link { color: var(--theme-color) !important; font-weight: 700; }
    .sidebar { border-right: 1px solid #e3e8e8; }
    .sidebar ul li > strong, .sidebar ul li > p > strong {
      display: block; margin-top: 1.1rem; font-size: .72rem; letter-spacing: .08em;
      text-transform: uppercase; color: #68787a;
    }
    .sidebar ul li a { font-size: .93rem; }
    .sidebar ul li.active > a { border-right: 2px solid var(--theme-color); font-weight: 600; }
    .markdown-section { max-width: var(--content-max-width); }
    .markdown-section h1 { font-size: 2rem; }
    .markdown-section h2 { margin-top: 2.6rem; padding-bottom: .35rem; border-bottom: 1px solid #e8eded; }
    .markdown-section table { display: table; width: 100%; font-size: .9rem; }
    .markdown-section th { background: #f2f7f6; text-align: left; }
    .markdown-section td, .markdown-section th { padding: .5rem .75rem; }
    .markdown-section code { font-size: .84em; }
    .markdown-section pre { border-radius: 6px; }
    .markdown-section blockquote { border-left-color: var(--theme-color); background: #f4faf9; padding: .6rem 1rem; }
    .markdown-section .mermaid { text-align: center; margin: 1.5rem 0; overflow-x: auto; }
    .table-wrap { overflow-x: auto; }
  </style>
</head>
<body>
  <div id="app">Cargando la documentación…</div>
  <script>
    window.$docsify = {
      name: 'Catalog Sync API',
      basePath: ${JSON.stringify(`${basePath}${CONTENT_PREFIX}/`)},
      homepage: ${JSON.stringify(HOME_FILE)},
      loadSidebar: true,
      relativePath: true,
      auto2top: true,
      subMaxLevel: 2,
      maxLevel: 3,
      search: {
        placeholder: 'Buscar',
        noData: 'Sin resultados',
        depth: 3,
      },
      markdown: {
        renderer: {
          code: function (code, lang) {
            if (lang === 'mermaid') {
              return '<pre class="mermaid">' + code.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
            }
            return this.origin.code.apply(this, arguments);
          },
        },
      },
      plugins: [
        function (hook) {
          hook.doneEach(function () {
            document.querySelectorAll('.markdown-section table').forEach(function (table) {
              if (table.parentElement.classList.contains('table-wrap')) return;
              var wrap = document.createElement('div');
              wrap.className = 'table-wrap';
              table.parentNode.insertBefore(wrap, table);
              wrap.appendChild(table);
            });
            if (window.mermaid) {
              window.mermaid.run({ querySelector: '.markdown-section pre.mermaid' });
            }
          });
        },
      ],
    };
  </script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
  <script>
    if (window.mermaid) { window.mermaid.initialize({ startOnLoad: false, theme: 'neutral' }); }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/docsify.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify@4.13.1/lib/plugins/search.min.js"></script>
</body>
</html>
`;
}
