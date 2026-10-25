import { Router } from 'express';
import { oauthConfig, resourceMetadata, sendAuthError } from '../lib/mcp/oauth-config.js';
export function createMetadataRouter() {
const metadataRouter = Router();
metadataRouter.get(['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${(process.env.BASE_URL || '').replace(/\/$/,'')}/api/mcp`], (req,res) => {
  try { res.set('Cache-Control','no-store').json(resourceMetadata(oauthConfig())); }
  catch(e) { sendAuthError(res,e); }
});

return metadataRouter;
}
export const metadataRouter=createMetadataRouter();
