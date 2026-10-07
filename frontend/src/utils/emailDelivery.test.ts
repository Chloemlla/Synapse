import { describe, expect, it } from 'vitest';
import { buildEmailDeliveryNotice } from './emailDelivery';

describe('email delivery result', () => {
  it('reports partial acceptance without claiming all addresses were sent', () => {
    expect(buildEmailDeliveryNotice(2, 5)).toEqual({ message: '已向 2 位收件人发送，其余地址未发送', type: 'warning' });
    expect(buildEmailDeliveryNotice(0, 5).type).toBe('warning');
  });

  it('reports full acceptance and remains compatible with an older response', () => {
    expect(buildEmailDeliveryNotice(5, 5)).toEqual({ message: '已向 5 位收件人发送', type: 'success' });
    expect(buildEmailDeliveryNotice(undefined, 5)).toEqual(buildEmailDeliveryNotice(5, 5));
  });
});
