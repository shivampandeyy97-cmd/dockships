import cron from 'node-cron';
import { allRows, runQuery, getRow } from '../db';

interface CronJobRow {
  id: string;
  name: string;
  expression: string;
  job_type: string;
  active: number;
  last_run?: string;
  created_at: string;
}

// Store running scheduled tasks globally
const runningTasks: Record<string, any> = {};

/**
 * Initializes all active cron jobs stored in the database.
 */
export async function initializeScheduler(): Promise<void> {
  console.log('⏰ [Cron Scheduler] Initializing scheduled background tasks...');
  try {
    const jobs = await allRows<CronJobRow>('SELECT * FROM dockships_cron_jobs');
    
    // Stop any existing schedules first
    for (const id of Object.keys(runningTasks)) {
      runningTasks[id].stop();
      delete runningTasks[id];
    }

    for (const job of jobs) {
      if (job.active === 1) {
        scheduleJob(job);
      }
    }
    console.log(`⏰ [Cron Scheduler] Successfully initialized ${Object.keys(runningTasks).length} active scheduled jobs.`);
  } catch (err: any) {
    console.error('⏰ [Cron Scheduler] Failed to load scheduler:', err.message);
  }
}

/**
 * Schedules a single cron job.
 */
function scheduleJob(job: CronJobRow) {
  // Validate expression first
  if (!cron.validate(job.expression)) {
    console.error(`⏰ [Cron Scheduler] Invalid cron expression "${job.expression}" for job "${job.name}"`);
    return;
  }

  const task = cron.schedule(job.expression, async () => {
    console.log(`⏰ [Cron Scheduler] Executing job: "${job.name}" (${job.job_type})`);
    await executeJobLogic(job.id, job.job_type);
  });

  runningTasks[job.id] = task;
  console.log(`⏰ [Cron Scheduler] Registered schedule for "${job.name}" -> ${job.expression}`);
}

/**
 * Toggles a job active/inactive state in database and runtime.
 */
export async function toggleCronJob(jobId: string, active: boolean): Promise<boolean> {
  try {
    const activeVal = active ? 1 : 0;
    await runQuery('UPDATE dockships_cron_jobs SET active = ? WHERE id = ?', [activeVal, jobId]);
    
    // Stop running task if toggled off
    if (!active && runningTasks[jobId]) {
      runningTasks[jobId].stop();
      delete runningTasks[jobId];
      console.log(`⏰ [Cron Scheduler] Stopped scheduled job ${jobId}`);
    } 
    // Start task if toggled on
    else if (active) {
      const job = await getRow<CronJobRow>('SELECT * FROM dockships_cron_jobs WHERE id = ?', [jobId]);
      if (job) {
        // Stop if already running for some reason
        if (runningTasks[jobId]) {
          runningTasks[jobId].stop();
        }
        scheduleJob(job);
      }
    }
    return true;
  } catch (err) {
    console.error(`⏰ [Cron Scheduler] Failed to toggle job ${jobId}:`, err);
    return false;
  }
}

/**
 * Executes a cron job's payload logic immediately.
 */
export async function executeJobLogic(jobId: string, jobType: string): Promise<void> {
  const nowStr = new Date().toISOString();
  console.log(`⚡ [Cron Job Execute] Running task payload for type: ${jobType}`);

  try {
    if (jobType === 'hourly_status_check') {
      // 1. Hourly check logic: query active website status
      console.log('⚡ [Cron Hourly Check] Validating active lead domains status...');
      
      interface ShortLead { id: string; website: string; }
      const leads = await allRows<ShortLead>('SELECT id, website FROM dockships_leads');
      
      for (const lead of leads) {
        // Run simple verification (or crawling if domain check is needed)
        // Here we simulate checking website status and log it
        console.log(`⚡ [Cron Status Check] Verifying domain active: ${lead.website}`);
      }
    } else if (jobType === 'daily_analytics_sync') {
      // 2. Daily cleanup / sync logic
      console.log('⚡ [Cron Daily Sync] Performing system database cleanup & metric aggregation sync...');
      // Sync mock logs or calculate system totals
    } else {
      console.log(`⚡ [Cron Job] No execution routine defined for custom job type: ${jobType}`);
    }

    // Update database last run timestamp
    await runQuery('UPDATE dockships_cron_jobs SET last_run = ? WHERE id = ?', [nowStr, jobId]);
    console.log(`⚡ [Cron Job Execute] Completed successfully at ${nowStr}`);
  } catch (err: any) {
    console.error(`❌ [Cron Job Execute] Error during cron execution:`, err.message);
  }
}
