import { getServiceDB } from '../../db/connection.js';
import { getBusinessDate, getBusinessDateTime, calculateWorkingMinutes } from '../../utils/businessTime.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AppError } from '../../shared/errors/errorHandler.js';

// Cutoff boundary for historical data exclusion
export const SALES_AUTOMATION_HISTORICAL_CUTOFF = '2026-10-08T00:00:00.000Z';
export const SALES_AUTOMATION_HISTORICAL_CUTOFF_DATE = '2026-10-08';

let isDetectorRunning = false;

export class SalesAutomationDetector {
  /**
   * Run detection cycle for sales automation alerts:
   * V1.0:
   * 1. LEAD_UNASSIGNED
   * 2. MANAGER_TASK_OVERDUE
   * 3. CALL_REMINDER
   * 4. MEETING_REMINDER
   * V1.1 (controlled by SALES_AUTOMATION_V1_1_ENABLED):
   * 5. LEAD_FIRST_CONTACT_WARNING (> 1 working hour)
   * 6. LEAD_FIRST_CONTACT_OVERDUE (> 2 working hours)
   * 7. LEAD_STAGNANT (> 48h without movement & no open tasks)
   * 8. LEADS_CONTROL_DIGEST (morning / evening digest)
   */
  static async runDetectionCycle({ businessDate = null, isDryRun = false } = {}) {
    // Race condition & concurrency protection lock
    if (isDetectorRunning) {
      console.warn('[SalesAutomationDetector] Detection cycle already running, skipping concurrent execution.');
      return { skipped: true, reason: 'CONCURRENT_EXECUTION_LOCKED' };
    }

    isDetectorRunning = true;
    const effectiveDate = businessDate || getBusinessDate();
    const isV11Enabled = process.env.SALES_AUTOMATION_V1_1_ENABLED === 'true';
    const db = getServiceDB();

    const stats = {
      businessDate: effectiveDate,
      // V1.0
      unassignedLeadsScanned: 0,
      unassignedLeadsNotified: 0,
      unassignedHistoricalExcluded: 0,
      overdueTasksScanned: 0,
      overdueTasksNotified: 0,
      overdueHistoricalExcluded: 0,
      callRemindersNotified: 0,
      meetingRemindersNotified: 0,
      // V1.1
      v11Enabled: isV11Enabled,
      firstContactWarningNotified: 0,
      firstContactOverdueNotified: 0,
      stagnantLeadsNotified: 0,
      controlDigestNotified: 0
    };

    try {
      // --- A. LEAD_UNASSIGNED DETECTION (V1.0) ---
      const { data: rawLeads, error: leadsErr } = await db
        .from('leads')
        .select('id, full_name, phone, status, responsible_user_id, created_at')
        .is('responsible_user_id', null)
        .in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION']);

      if (leadsErr) {
        console.error('[SalesAutomationDetector] Error querying unassigned leads:', leadsErr.message);
        throw new AppError(`DB error querying unassigned leads: ${leadsErr.message}`, 500);
      }

      const unassignedLeads = rawLeads || [];
      stats.unassignedLeadsScanned = unassignedLeads.length;

      for (const lead of unassignedLeads) {
        const leadCreatedISO = new Date(lead.created_at).toISOString();
        if (leadCreatedISO < SALES_AUTOMATION_HISTORICAL_CUTOFF) {
          stats.unassignedHistoricalExcluded++;
          continue;
        }

        stats.unassignedLeadsNotified++;
        if (!isDryRun) {
          await NotificationsService.notifyLeadUnassigned(lead);
        }
      }

      // --- B. TASK-BASED DETECTIONS (OVERDUE, CALL, MEETING) (V1.0) ---
      const { data: rawTasks, error: tasksErr } = await db
        .from('tasks')
        .select(`
          id,
          lead_id,
          deal_id,
          assigned_user_id,
          created_by,
          type,
          title,
          description,
          client_name,
          phone,
          due_date,
          status,
          created_at,
          leads ( id, full_name, phone )
        `)
        .eq('status', 'OPEN');

      if (tasksErr) {
        console.error('[SalesAutomationDetector] Error querying tasks:', tasksErr.message);
        throw new AppError(`DB error querying tasks: ${tasksErr.message}`, 500);
      }

      const openTasks = rawTasks || [];

      for (const task of openTasks) {
        if (!task.due_date) continue;

        // 1) Overdue Tasks: due_date < effectiveDate
        if (task.due_date < effectiveDate) {
          stats.overdueTasksScanned++;

          const taskCreatedISO = task.created_at ? new Date(task.created_at).toISOString() : '';
          const isHistoricalBacklog = task.due_date < SALES_AUTOMATION_HISTORICAL_CUTOFF_DATE && taskCreatedISO < SALES_AUTOMATION_HISTORICAL_CUTOFF;

          if (isHistoricalBacklog) {
            stats.overdueHistoricalExcluded++;
            continue;
          }

          stats.overdueTasksNotified++;
          if (!isDryRun) {
            await NotificationsService.notifyManagerTaskOverdue(task);
          }
        }

        // 2) Today Reminders: due_date === effectiveDate
        if (task.due_date === effectiveDate) {
          if (task.type === 'CALL') {
            stats.callRemindersNotified++;
            if (!isDryRun) {
              await NotificationsService.notifyCallReminder(task);
            }
          } else if (task.type === 'MEETING') {
            stats.meetingRemindersNotified++;
            if (!isDryRun) {
              await NotificationsService.notifyMeetingReminder(task);
            }
          }
        }
      }

      // --- C, D, E. V1.1: LEAD SLA CONTROL, STAGNANT & DIGEST (GATED BY isV11Enabled) ---
      if (isV11Enabled) {
        // --- C. V1.1: FIRST CONTACT SLA CONTROL (1H WARNING & 2H OVERDUE) ---
        const { data: rawAssignedNewLeads, error: assignedErr } = await db
          .from('leads')
          .select(`
            id,
            full_name,
            phone,
            status,
            responsible_user_id,
            created_at,
            updated_at,
            users!responsible_user_id ( id, name ),
            lead_notes ( id, created_at ),
            tasks ( id, status, type, due_date ),
            deals ( id )
          `)
          .eq('status', 'NEW')
          .not('responsible_user_id', 'is', null);

        if (!assignedErr && rawAssignedNewLeads) {
          const now = new Date();

          for (const lead of rawAssignedNewLeads) {
            const leadCreatedISO = new Date(lead.created_at).toISOString();
            if (leadCreatedISO < SALES_AUTOMATION_HISTORICAL_CUTOFF) {
              continue; // Historical leads excluded
            }

            // Multi-signal contact check:
            // Check if contact was recorded through notes, completed tasks, or deals
            const hasNotes = (lead.lead_notes && lead.lead_notes.length > 0);
            const hasCompletedTask = (lead.tasks && lead.tasks.some(t => t.status === 'COMPLETED'));
            const hasDeals = (lead.deals && lead.deals.length > 0);
            const isFirstContactRecorded = hasNotes || hasCompletedTask || hasDeals;

            if (!isFirstContactRecorded) {
              const workingMins = calculateWorkingMinutes(lead.created_at, now);

              if (workingMins >= 120) {
                stats.firstContactOverdueNotified++;
                if (!isDryRun) {
                  await NotificationsService.notifyLeadFirstContactOverdue(lead, lead.responsible_user_id, workingMins);
                }
              } else if (workingMins >= 60) {
                stats.firstContactWarningNotified++;
                if (!isDryRun) {
                  await NotificationsService.notifyLeadFirstContactWarning(lead, lead.responsible_user_id, workingMins);
                }
              }
            }
          }
        }

        // --- D. V1.1: STAGNANT LEADS CONTROL (> 48H WITHOUT NEXT ACTION) ---
        const { data: rawActiveLeads, error: activeErr } = await db
          .from('leads')
          .select(`
            id,
            full_name,
            phone,
            status,
            responsible_user_id,
            created_at,
            updated_at,
            users!responsible_user_id ( id, name ),
            lead_notes ( id, created_at ),
            tasks ( id, status, due_date )
          `)
          .in('status', ['IN_PROGRESS', 'NEGOTIATION'])
          .not('responsible_user_id', 'is', null);

        if (!activeErr && rawActiveLeads) {
          const now = new Date();

          for (const lead of rawActiveLeads) {
            const leadCreatedISO = new Date(lead.created_at).toISOString();
            if (leadCreatedISO < SALES_AUTOMATION_HISTORICAL_CUTOFF) {
              continue; // Historical leads excluded
            }

            // Check if any OPEN tasks are scheduled
            const openLeadTasks = (lead.tasks || []).filter(t => t.status === 'OPEN');
            if (openLeadTasks.length > 0) {
              continue; // Has scheduled next action, NOT stagnant
            }

            // Compute latest activity timestamp
            let latestActivity = new Date(lead.updated_at || lead.created_at).getTime();
            (lead.lead_notes || []).forEach(n => {
              const nt = new Date(n.created_at).getTime();
              if (nt > latestActivity) latestActivity = nt;
            });

            const hoursInactive = Math.floor((now.getTime() - latestActivity) / (3600 * 1000));
            if (hoursInactive >= 48) {
              stats.stagnantLeadsNotified++;
              if (!isDryRun) {
                await NotificationsService.notifyLeadStagnant(lead, lead.responsible_user_id, hoursInactive, effectiveDate);
              }
            }
          }
        }

        // --- E. V1.1: LEADS CONTROL DIGEST (MORNING 09:00 / EVENING 18:00 TJT) ---
        const bdt = getBusinessDateTime();
        const currentHour = parseInt(bdt.timeStr.split(':')[0], 10);
        let digestPeriod = null;
        if (currentHour === 9) digestPeriod = 'MORNING';
        else if (currentHour === 18) digestPeriod = 'EVENING';

        if (digestPeriod) {
          const hasIssues = stats.unassignedLeadsScanned > 0 ||
            stats.firstContactOverdueNotified > 0 ||
            stats.stagnantLeadsNotified > 0 ||
            stats.overdueTasksNotified > 0;

          if (hasIssues) {
            stats.controlDigestNotified++;
            if (!isDryRun) {
              await NotificationsService.notifyLeadsControlDigest({
                unassignedCount: stats.unassignedLeadsScanned,
                overdueContactCount: stats.firstContactOverdueNotified,
                stagnantCount: stats.stagnantLeadsNotified,
                overdueTasksCount: stats.overdueTasksNotified
              }, digestPeriod, effectiveDate);
            }
          }
        }
      }

      return stats;
    } finally {
      isDetectorRunning = false;
    }
  }

  /**
   * Helper to retrieve list of 44 historical unassigned leads for owner review
   */
  static async getHistoricalUnassignedLeads() {
    const db = getServiceDB();
    const { data: rawLeads } = await db
      .from('leads')
      .select('id, full_name, phone, status, responsible_user_id, created_at')
      .is('responsible_user_id', null)
      .in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION'])
      .order('created_at', { ascending: true });

    const unassignedLeads = rawLeads || [];
    return unassignedLeads.filter(l => new Date(l.created_at).toISOString() < SALES_AUTOMATION_HISTORICAL_CUTOFF);
  }
}
