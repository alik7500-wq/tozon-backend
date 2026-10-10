import { getServiceDB } from '../../db/connection.js';
import { getBusinessDate } from '../../utils/businessTime.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AppError } from '../../shared/errors/errorHandler.js';

// Cutoff boundary for historical data exclusion
export const SALES_AUTOMATION_HISTORICAL_CUTOFF = '2026-10-08T00:00:00.000Z';
export const SALES_AUTOMATION_HISTORICAL_CUTOFF_DATE = '2026-10-08';

let isDetectorRunning = false;

export class SalesAutomationDetector {
  /**
   * Run detection cycle for sales automation alerts:
   * 1. LEAD_UNASSIGNED
   * 2. MANAGER_TASK_OVERDUE
   * 3. CALL_REMINDER
   * 4. MEETING_REMINDER
   */
  static async runDetectionCycle({ businessDate = null, isDryRun = false } = {}) {
    // Race condition & concurrency protection lock
    if (isDetectorRunning) {
      console.warn('[SalesAutomationDetector] Detection cycle already running, skipping concurrent execution.');
      return { skipped: true, reason: 'CONCURRENT_EXECUTION_LOCKED' };
    }

    isDetectorRunning = true;
    const effectiveDate = businessDate || getBusinessDate();
    const db = getServiceDB();

    const stats = {
      businessDate: effectiveDate,
      unassignedLeadsScanned: 0,
      unassignedLeadsNotified: 0,
      unassignedHistoricalExcluded: 0,
      overdueTasksScanned: 0,
      overdueTasksNotified: 0,
      overdueHistoricalExcluded: 0,
      callRemindersNotified: 0,
      meetingRemindersNotified: 0
    };

    try {
      // --- A. LEAD_UNASSIGNED DETECTION ---
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

      // --- B. TASK-BASED DETECTIONS (OVERDUE, CALL, MEETING) ---
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
