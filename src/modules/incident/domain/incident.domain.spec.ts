import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import incidentDomain from '@/modules/incident/domain/incident.domain';

describe('incidentDomain.proposeDraft', () => {
  const monitorId = '11111111-1111-4111-8111-111111111111';
  const serviceId = '22222222-2222-4222-8222-222222222222';

  it('builds a critical monitoring draft with no author', () => {
    const draft = incidentDomain().proposeDraft('org', {
      monitorId,
      serviceId,
      monitorName: 'API',
      failureEpisode: 3,
    });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.source, 'monitoring');
    assert.equal(draft.impact, 'critical');
    assert.equal(draft.title, 'Monitor failure: API');
    assert.equal(draft.createdByUserId, null);
    assert.equal(draft.originMonitorId, monitorId);
    assert.equal(draft.originFailureEpisode, 3);
    assert.equal(draft.resolvedAt, null);
    assert.deepEqual(draft.affectedServices, [
      { serviceId, impact: 'critical' },
    ]);
  });

  it('leaves the origin empty for a declared incident', () => {
    const declared = incidentDomain().declareIncident('org', 'user', {
      title: 'x',
      impact: 'minor',
    });
    assert.equal(declared.originFailureEpisode, null);
  });
});
