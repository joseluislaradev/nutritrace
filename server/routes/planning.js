import { Router } from 'express';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { planningService } from '../lib/planning-service.js';
import { commands } from '../lib/planning-contracts.js';
const router=Router();
router.use(requireAuth);
router.get('/contracts',(_req,res)=>res.json(Object.keys(commands)));
router.post('/:command',(req,res)=>{
  try {res.json(planningService.execute(userMgmtActive()?req.user.id:0,req.params.command,req.body,'manual'));}
  catch(e){res.status(e.status||500).json({error:e.status?e.message:'Planning operation failed'});}
});
export default router;
