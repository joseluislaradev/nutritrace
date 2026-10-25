import { authorizedRegistrar } from './auth-policy.js';
/**
 * server/lib/mcp/server.js
 *
 * Handle a single MCP request over the Streamable HTTP transport.
 *
 * Uses stateless mode: a fresh McpServer + StreamableHTTPServerTransport
 * pair per HTTP request. Tool state lives in SQLite, with no protocol
 * session state to persist, so session management would just
 * be maintenance burden. If a future tool needs a session (long-lived
 * subscriptions, resumable streams), revisit and switch to stateful.
 *
 * Auth + rate limit + origin check happen upstream in the Express
 * router — by the time this function runs, req.mcpAuth is trusted
 * and identifies the caller.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { APP_VERSION } from '../../routes/version-source.js';
import { registerReadTools, registerWriteTools, registerDestroyTools } from './tools/index.js';

export async function handleMcpRequest(req, res) {
  const transport = new StreamableHTTPServerTransport({
    // Stateless — no session id, every request self-contained.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = new McpServer(
    {
      name: 'nutritrace',
      version: String(APP_VERSION || '0.0.0').replace(/^v/, ''),
    },
    {
      // Advertise only tools capability; Phase 1 has no resources/prompts.
      capabilities: { tools: {} },
    }
  );
  const auth = req.mcpAuth;
  const ctx = { userId: auth.userId };
  const registrar = authorizedRegistrar(server, auth);
  if (auth.authKind === 'oauth' || auth.scopes.includes('mcp:read')) registerReadTools(registrar, ctx);
  if (req.mcpWrites) registerWriteTools(registrar, ctx);
  if (req.mcpDestroy) registerDestroyTools(registrar, ctx);

  await server.connect(transport);
  try {
    await transport.handleRequest(req, res, req.body);
  } finally {
    // Tear down the per-request transport once the SDK is done, whether
    // the response ended cleanly or the client aborted. Called inside
    // `finally` (not on `res.on('close')`) so it never races the SDK's
    // own writes; wrapped in try because double-close is harmless but
    // the SDK doesn't currently guarantee it's a no-op.
    try { await server.close(); } catch { /* ignore */ }
  }
}
