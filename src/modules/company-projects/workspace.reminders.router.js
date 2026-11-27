import {Router} from 'express';
import {verifySchedulerToken} from '../../middleware/schedulerAuth.middleware.js';
import {assertInternalReminders,refreshProjectReminders} from './workspace.reminders.js';
const router=Router();
router.post('/run',verifySchedulerToken,async(req,res,next)=>{
 try{assertInternalReminders();res.json({status:'success',data:await refreshProjectReminders()});}catch(e){next(e);}
});
export default router;
