import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('reports ok', () => {
    expect(new HealthController().check().status).toBe('ok');
  });
});
