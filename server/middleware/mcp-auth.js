import db from '../db.js';
import { bearerAuth } from './bearer-auth.js';
import { verifyOAuthToken } from '../lib/mcp/oauth-auth.js';
import { sendAuthError, McpAuthError } from '../lib/mcp/oauth-config.js';
import { makeRateLimiter } from './rate-limit.js';
const attempts = makeRateLimiter({max:120, windowMs:60000, label:'mcp-auth'});
const counts = new Map();
export function createMcpAuth(verify = verifyOAuthToken) {
  return async (req,res,next) => {
    const match = (req.get('authorization') || '').match(/^Bearer\s+(\S+)\s*$/i);
    if (!match) return sendAuthError(res, new McpAuthError(401,'auth_missing'));
    if (match[1].startsWith('nt_pat_')) {
      return bearerAuth(req,res,() => {
        req.mcpAuth = {authKind:'pat',userId:req.apiUser.id,scopes:req.apiToken.scopes,principalId:`pat:${req.apiToken.id}`};
        next();
      });
    }
    try {
      req.mcpAuth = await verify(match[1]);
      const user = db.prepare('SELECT id FROM users WHERE id=?').get(req.mcpAuth.userId);
      if (!user) throw new McpAuthError(403,'owner_not_allowed',undefined,'local_user_missing');
      const key = req.mcpAuth.principalId, now = Date.now();
      for (const [k,b] of counts) if (b.reset <= now) counts.delete(k);
      const b = counts.get(key) || {reset:now+60000,count:0};
      counts.set(key,b); b.count++;
      if (b.count > 60) { res.set('Retry-After',String(Math.ceil((b.reset-now)/1000))); return res.status(429).json({error:'rate_limited'}); }
      next();
    } catch(e) { return sendAuthError(res,e); }
  };
}
export const mcpAuth = createMcpAuth();
export const mcpAttemptLimit = attempts;
