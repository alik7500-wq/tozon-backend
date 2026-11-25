import { describe, it, expect } from 'vitest';
import {
  resolveCanonicalStage,
  validateStageTransition,
  buildLeadAccessScope,
  classifyCommunicationEffect,
  COMMUNICATION_EVENT_TYPES
} from '../leadDomain.js';

describe('leadDomain (F-01, F-02, F-12, RBAC)', () => {
  it('never promotes legacy WON without a SIGNED deal into SIGNED (F-02, A24)', () => {
    const res = resolveCanonicalStage({ id: 1, status: 'WON', stage: 'WON' }, []);
    expect(res.stage).toBe('CONTRACT_PREP');
    expect(res.legacy_unverified_won).toBe(true);

    const signed = resolveCanonicalStage({ id: 1, status: 'WON' }, [{ id: 10, status: 'SIGNED' }]);
    expect(signed.stage).toBe('SIGNED');
    expect(signed.legacy_unverified_won).toBe(false);
  });

  it('requires lost reason and comment for OTHER, and blocks free editing of SIGNED (A23, F-02)', () => {
    expect(validateStageTransition({ currentStage: 'NEW', targetStage: 'LOST' }).code).toBe('LOST_REASON_REQUIRED');
    expect(
      validateStageTransition({ currentStage: 'NEW', targetStage: 'LOST', reasonCode: 'OTHER', reasonComment: '   ' }).code
    ).toBe('LOST_COMMENT_REQUIRED');
    expect(
      validateStageTransition({ currentStage: 'NEW', targetStage: 'LOST', reasonCode: 'OTHER', reasonComment: 'Дорого' }).ok
    ).toBe(true);
    expect(validateStageTransition({ currentStage: 'SIGNED', targetStage: 'NEGOTIATION', reasonComment: 'Отмена' }).code).toBe(
      'SIGNED_READ_ONLY'
    );
    expect(validateStageTransition({ currentStage: 'CONTRACT_PREP', targetStage: 'SIGNED' }).code).toBe('SIGNED_REQUIRES_DEAL');
  });

  it('requires reason on backward transition and details for meeting/showing (F-02)', () => {
    expect(validateStageTransition({ currentStage: 'NEGOTIATION', targetStage: 'IN_PROGRESS' }).code).toBe(
      'BACKWARD_REASON_REQUIRED'
    );
    expect(
      validateStageTransition({ currentStage: 'NEGOTIATION', targetStage: 'IN_PROGRESS', reasonComment: 'Ошибочно перевели' }).ok
    ).toBe(true);
    expect(validateStageTransition({ currentStage: 'IN_PROGRESS', targetStage: 'MEETING_SCHEDULED' }).code).toBe(
      'MEETING_DETAILS_REQUIRED'
    );
    expect(validateStageTransition({ currentStage: 'MEETING_SCHEDULED', targetStage: 'SHOWING_DONE' }).code).toBe(
      'SHOWING_DETAILS_REQUIRED'
    );
  });

  it('enforces SALES_MANAGER scope even if managerId=ALL is passed (Section 13)', () => {
    const mgrScope = buildLeadAccessScope({ id: 42, role: 'SALES_MANAGER' }, { managerId: 'ALL' });
    expect(mgrScope.restrictedToSelf).toBe(true);
    expect(mgrScope.effectiveFilters.responsibleUserId).toBe('42');

    const dirScope = buildLeadAccessScope({ id: 1, role: 'DIRECTOR' }, { managerId: 'ALL' });
    expect(dirScope.restrictedToSelf).toBe(false);
    expect(dirScope.effectiveFilters.responsibleUserId).toBeUndefined();
  });

  it('distinguishes NO_ANSWER attempt from CONNECTED_CALL and AUTO_NOTIFICATION (F-12, A18)', () => {
    expect(classifyCommunicationEffect(COMMUNICATION_EVENT_TYPES.NO_ANSWER)).toEqual({
      countsAsHumanAction: true,
      countsAsFirstResponse: false,
      countsAsConfirmedContact: false
    });
    expect(classifyCommunicationEffect(COMMUNICATION_EVENT_TYPES.CONNECTED_CALL)).toEqual({
      countsAsHumanAction: true,
      countsAsFirstResponse: true,
      countsAsConfirmedContact: true
    });
    expect(classifyCommunicationEffect(COMMUNICATION_EVENT_TYPES.AUTO_NOTIFICATION)).toEqual({
      countsAsHumanAction: false,
      countsAsFirstResponse: false,
      countsAsConfirmedContact: false
    });
  });
});
